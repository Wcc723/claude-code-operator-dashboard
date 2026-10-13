import { Router } from 'express';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { homedir } from 'node:os';

// AppleScript 字串內的 " 要轉成 \" ，\ 要轉成 \\
function escapeAS(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const CLIENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ORDER_MAX_IDS = 500;

// insights 讀的是 Claude Code 未公開的內部檔案，壞掉時不能連帶讓 session 列表掛掉：
// 退回只用 PTY record 推得出來的欄位（同 EnrichedSession 形狀，前端不必特判）。
function basicEnrich(rec) {
  const home = homedir();
  const cwd = rec.cwd || '';
  const cwdShort = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
  const exited = rec.status === 'exited';
  return {
    ...rec,
    cwd_short: cwdShort,
    title: rec.profile_name || basename(cwd) || rec.id,
    title_source: 'fallback',
    last_prompt: null,
    context_left_pct: null,
    hook_seen: null,
    statusline_seen: null,
    activity: {
      state: exited ? 'ended' : 'unknown',
      since: exited ? rec.exited_at : null,
      reason: null,
      last_tool: null,
      source: null,
    },
  };
}

let lastEnrichError = '';
function reportEnrichError(e) {
  const msg = String(e?.message ?? e);
  // 前端每 5 秒 poll，同一個錯誤只記一次
  if (msg === lastEnrichError) return;
  lastEnrichError = msg;
  console.error('[sessions] insights enrich failed:', msg);
}

export async function enrichList(insights, list) {
  if (!insights?.enrich) return list.map(basicEnrich);
  try { return await insights.enrich(list); }
  catch (e) { reportEnrichError(e); return list.map(basicEnrich); }
}

export async function enrichRecord(insights, rec) {
  if (!insights?.enrichOne) return basicEnrich(rec);
  try { return await insights.enrichOne(rec); }
  catch (e) { reportEnrichError(e); return basicEnrich(rec); }
}

export function sessionsRouter(terminal, insights) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json({ items: await enrichList(insights, terminal.list()) });
  });

  // 側欄拖曳排序。body: { ids: [sessionId, ...] }（新順序；沒列到的接在後面），回傳排好的完整列表
  router.put('/order', async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > ORDER_MAX_IDS
      || !ids.every(x => typeof x === 'string' && x.length > 0 && x.length <= 64)) {
      return res.status(400).json({ error: 'ids must be an array of session ids' });
    }
    res.json({ items: await enrichList(insights, terminal.reorder(ids)) });
  });

  router.get('/:id', async (req, res) => {
    const s = terminal.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(await enrichRecord(insights, s));
  });

  router.get('/:id/log', (req, res) => {
    const tail = Number(req.query.tail || 200);
    const text = terminal.logTail(req.params.id, tail);
    if (text === null) return res.status(404).json({ error: 'not found' });
    res.json({ log: text });
  });

  // SSE stream — 持續推 PTY raw bytes 給 xterm.js
  // 流程：1) reset（EventSource 自動重連時讓 client 先清畫面，catch-up 才不會重複疊上去）
  //       2) size（目前 PTY 尺寸 + 由哪台裝置控制）
  //       3) flush ring buffer 內容做 catch-up，接著 caughtup（reset 的 data 帶 caughtup:true 宣告會有這個標記）
  //       4) subscribe 後續 data + resize + exit
  //       5) 30s ping keep-alive（防 Cloudflare idle timeout）
  //       6) req close → unsubscribe + clearInterval
  router.get('/:id/stream', (req, res) => {
    const id = req.params.id;
    const session = terminal.get(id);
    if (!session) return res.status(404).json({ error: 'not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 防 nginx / proxy buffer
    res.flushHeaders?.();

    // 對 SSE socket 個別取消 idle timeout。
    // 全域 server.keepAliveTimeout=1000 是給普通 HTTP 用（讓 port 不卡 TIME_WAIT），
    // 但 SSE 是 long-lived「server 持續 push、client 不發新 request」連線，
    // 1 秒後 Node 會誤判成 idle 砍 socket → SSE 完全收不到 data。
    req.socket?.setTimeout(0);
    req.socket?.setKeepAlive(true);
    req.socket?.setNoDelay(true);

    function sendData(buf) {
      // buf 是來自 PTY 的 raw Buffer（terminal-manager spawn 用 encoding: null）
      // 直接 base64 不經 string 解碼，避免 multi-byte UTF-8 被截掉低 byte
      // base64 encode 同時避免 SSE 對 \n \r 行格式敏感
      const b64 = buf.toString('base64');
      res.write(`event: data\ndata: ${b64}\n\n`);
    }

    function sendExit(payload) {
      res.write(`event: exit\ndata: ${JSON.stringify(payload)}\n\n`);
    }

    function sendSize({ cols, rows, client_id }) {
      res.write(`event: size\ndata: ${JSON.stringify({ cols, rows, client_id: client_id ?? null })}\n\n`);
    }

    res.write('event: reset\ndata: {"caughtup":true}\n\n');
    sendSize({ cols: session.cols, rows: session.rows, client_id: session.controller_client_id });

    // catch-up：先把 ring buffer 既有內容推給 client（跟 subscribe 同一個 tick，中間不會漏 data）
    const catchUp = terminal.logFull(id);
    if (catchUp?.length) sendData(catchUp);
    // 重播結束標記（ring 是空的也送）：client 在這之前不把 xterm 對舊查詢（DA / OSC 11…）的自動回應送進 PTY。
    // 慢速連線收完幾 MB 的 catch-up 可能要好幾秒，不能靠時間差判斷
    res.write('event: caughtup\ndata: {}\n\n');

    const unsubscribe = terminal.subscribe(id, {
      onData: sendData,
      onResize: sendSize,
      onExit: (payload) => {
        sendExit(payload);
        // 給 client 一秒 read exit 後再 close
        setTimeout(() => res.end(), 1000);
      },
    });

    const pingInterval = setInterval(() => {
      res.write(': ping\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(pingInterval);
      unsubscribe?.();
    });
  });

  // 寫 stdin 進指定 session 的 PTY。body: { data: base64string }
  // 走 base64 是為了讓 control byte / ANSI escape / 任意 binary 都能無損傳遞，
  // 跟 SSE 出口的 base64 對稱（兩邊 transport 都是 raw bytes）。
  router.post('/:id/input', (req, res) => {
    const b64 = req.body?.data;
    if (typeof b64 !== 'string') {
      return res.status(400).json({ error: 'data (base64 string) required' });
    }
    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch { return res.status(400).json({ error: 'invalid base64' }); }
    if (buf.length === 0) return res.status(204).end();

    const result = terminal.write(req.params.id, buf);
    if (result === null) return res.status(404).json({ error: 'not found' });
    if (result === false) return res.status(409).json({ error: 'session not running' });
    res.status(204).end();
  });

  // 由「最後操作的裝置」決定 PTY 尺寸。body: { cols:int, rows:int, client_id }
  router.post('/:id/resize', (req, res) => {
    const { cols, rows, client_id } = req.body ?? {};
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      return res.status(400).json({ error: 'cols and rows must be integers' });
    }
    if (typeof client_id !== 'string' || !CLIENT_ID_RE.test(client_id)) {
      return res.status(400).json({ error: 'invalid client_id' });
    }
    const cur = terminal.get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.status !== 'running') return res.status(409).json({ error: 'session not running' });

    const s = terminal.resize(req.params.id, cols, rows, client_id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ cols: s.cols, rows: s.rows, client_id: s.controller_client_id });
  });

  router.post('/', async (req, res, next) => {
    try {
      const profile_id = Number(req.body?.profile_id);
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' });
      // cols/rows 選填；非數字就用預設，範圍由 terminal-manager clamp
      const { cols, rows } = req.body ?? {};
      const s = await terminal.spawn({ profile_id, cols, rows });
      res.status(201).json(await enrichRecord(insights, s));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  // KILL：終止 process（status→exited），session 仍留在列表
  router.post('/:id/kill', async (req, res) => {
    const s = await terminal.kill(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(await enrichRecord(insights, s));
  });

  // DELETE：soft-delete，從預設列表移除（filter 可顯示）。若還在跑會先 kill。
  router.delete('/:id', async (req, res) => {
    const s = await terminal.remove(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(await enrichRecord(insights, s));
  });

  // 在 macOS 桌面另開一個 Terminal.app 視窗跑同樣的 command（獨立進程，不關聯既有 PTY）
  router.post('/:id/open-desktop', (req, res) => {
    if (process.platform !== 'darwin') {
      return res.status(400).json({ error: 'desktop terminal only supported on macOS' });
    }
    const s = terminal.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });

    const script = `tell application "Terminal"
  activate
  do script "cd \\"${escapeAS(s.cwd)}\\" && ${escapeAS(s.command)}"
end tell`;

    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => {
      if (err) {
        console.error('[open-desktop] osascript failed:', err.message);
      }
    });
    // fire-and-forget：不等 osascript 完成
    res.json({ ok: true });
  });

  router.post('/:id/restart', async (req, res, next) => {
    try {
      const s = await terminal.restart(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      res.json(await enrichRecord(insights, s));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  return router;
}
