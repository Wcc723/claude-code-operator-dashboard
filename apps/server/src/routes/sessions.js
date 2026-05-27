import { Router } from 'express';
import { execFile } from 'node:child_process';
import { tlog } from '../services/trace.js';

// AppleScript 字串內的 " 要轉成 \" ，\ 要轉成 \\
function escapeAS(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function sessionsRouter(terminal) {
  const router = Router();

  router.get('/', (req, res) => res.json({ items: terminal.list() }));

  router.get('/:id', (req, res) => {
    const s = terminal.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s);
  });

  router.get('/:id/log', (req, res) => {
    const tail = Number(req.query.tail || 200);
    const text = terminal.logTail(req.params.id, tail);
    if (text === null) return res.status(404).json({ error: 'not found' });
    res.json({ log: text });
  });

  // SSE stream — 持續推 PTY raw bytes 給 xterm.js
  // 流程：1) 先 flush ring buffer 內容做 catch-up
  //       2) subscribe 後續 data + exit
  //       3) 30s ping keep-alive（防 Cloudflare idle timeout）
  //       4) req close → unsubscribe + clearInterval
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

    // 1) catch-up：先把 ring buffer 既有內容推給 client
    const catchUp = terminal.logFull(id);
    tlog('sse', `→ open ${id.slice(0, 8)} catchUp=${catchUp ? catchUp.length : 0}B listeners=${session._emitter?.listenerCount?.('data') ?? '?'}`);
    if (catchUp) sendData(catchUp);

    // 2) subscribe live stream
    const unsubscribe = terminal.subscribe(id, {
      onData: sendData,
      onExit: (payload) => {
        sendExit(payload);
        // 給 client 一秒 read exit 後再 close
        setTimeout(() => res.end(), 1000);
      },
    });
    tlog('sse', `subscribed ${id.slice(0, 8)} now listeners=${session._emitter?.listenerCount?.('data')}`);

    // 3) keep-alive ping
    const pingInterval = setInterval(() => {
      res.write(': ping\n\n');
    }, 30000);

    // 4) cleanup
    req.on('close', () => {
      clearInterval(pingInterval);
      unsubscribe?.();
      tlog('sse', `✗ close ${id.slice(0, 8)} now listeners=${session._emitter?.listenerCount?.('data')}`);
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

  router.post('/', async (req, res, next) => {
    try {
      const profile_id = Number(req.body?.profile_id);
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' });
      res.status(201).json(await terminal.spawn({ profile_id }));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const s = await terminal.kill(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s);
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
      res.json(s);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  return router;
}
