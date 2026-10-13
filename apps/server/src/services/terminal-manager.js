import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

const RING_MAX = 2000;
// chunk 數之外再限總 bytes：避免大量輸出（例如 cat 大檔）讓單一 session 吃掉幾百 MB
const RING_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const COLS_MIN = 20, COLS_MAX = 500;
const ROWS_MIN = 5, ROWS_MAX = 200;

// 兩階段強制終止：SIGTERM → 等 5s → SIGKILL → 再等 2s 收尾
const KILL_TERM_TIMEOUT_MS = 5000;
const KILL_FORCE_TIMEOUT_MS = 2000;

// 只把無關 secret 的環境變數傳給 PTY 子進程；避免 SESSION_SECRET / GOOGLE_CLIENT_ID
// 等被 spawn 出來的 shell 看見或寫進 session log。
const SAFE_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'TMPDIR',
  // setup 寫的是 $CLAUDE_CONFIG_DIR/settings.json：spawn 出來的 claude 要讀同一份才會跑到 CODD 的 hooks / statusline
  'CLAUDE_CONFIG_DIR',
];

// 阻擋 user-supplied profile.env 注入危險 key
const BLOCKED_ENV_PREFIX = ['LD_', 'DYLD_', 'NODE_OPTIONS'];
const BLOCKED_ENV_EXACT = new Set(['PATH', 'NODE_PATH']);

function sanitizeProfileEnv(envObj) {
  if (!envObj || typeof envObj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(envObj)) {
    if (BLOCKED_ENV_EXACT.has(k)) continue;
    if (BLOCKED_ENV_PREFIX.some(p => k.startsWith(p))) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return resolve(homedir(), p.slice(1).replace(/^\//, ''));
  return p;
}

function clampDim(v, min, max, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 只有「開互動 session」的形式才接 --session-id：單純 `claude`，或第一個參數是 flag / 帶引號的 prompt。
// `claude mcp list`、`claude doctor`、`claude update` 這類子指令不認 --session-id，接上去會直接報錯退出；
// 子指令清單每版都在變，所以用正面表列。沒接上的（例如沒加引號的單字 prompt）仍會靠 hook 的 CODD_TERMINAL_ID 連結
const CLAUDE_CMD_RE = /^\s*claude(\s*$|\s+['"-])/;
const SESSION_FLAG_RE = /(^|\s)(-c|-r|--continue|--resume|--session-id|--fork-session)(\s|=|$)/;
// 換行 = 另一條指令、# = 後面接的 flag 會被當註解吃掉，這兩種也不能直接往後接
const SHELL_CONTROL_RE = /[;&|<>`\n\r#]|\$\(/;

// 單純的 `claude …` 指令就帶 --session-id（PTY id 兼任 Claude session id），
// 之後不靠 hook 也能從 transcript 找到這個 session 的標題。
// 已指定續接 / fork 的、或含 shell 控制字元（往後接 flag 會接錯位置）的一律不動。
export function buildSpawnCommand(command, id) {
  const cmd = String(command ?? '');
  const trimmed = cmd.trimEnd();
  const linkable = CLAUDE_CMD_RE.test(cmd)
    && !SESSION_FLAG_RE.test(cmd)
    && !SHELL_CONTROL_RE.test(cmd)
    && !trimmed.endsWith('\\');
  if (!linkable) return { command: cmd, claude_session_id: null };
  return { command: `${trimmed} --session-id ${id}`, claude_session_id: id };
}

export class TerminalManager {
  constructor({ profiles, logDir, shell = process.env.SHELL || '/bin/zsh' }) {
    this.profiles = profiles;
    this.logDir = resolve(logDir);
    this.shell = shell;
    this.sessions = new Map();
    mkdirSync(this.logDir, { recursive: true });

    // 同步保險：process 'exit' 是同步事件，event loop 已停，無法 await。
    // 這裡只是「人都要走了還是禮貌敲一下」，讓還活著的 PTY 收到 SIGTERM。
    // 真正等子進程死乾淨的邏輯在 index.js 的 shutdown() 裡 await killAll()。
    process.on('exit', () => {
      for (const s of this.sessions.values()) {
        if (s.status === 'running' && s._pty) {
          try { s._pty.kill('SIGTERM'); } catch {}
        }
      }
    });
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => a.order - b.order)
      .map(s => this._toJson(s));
  }

  // 側欄拖曳排序：ids 依新順序排最前面，沒列到的（例如已停止的）維持原本相對順序接在後面。
  // 順序只放記憶體，跟 PTY 同生命週期（server 重啟後 session 本來就都不在了）
  reorder(ids) {
    const listed = [];
    const seen = new Set();
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && !seen.has(id)) { seen.add(id); listed.push(s); }
    }
    const rest = [...this.sessions.values()]
      .filter(s => !seen.has(s.id))
      .sort((a, b) => a.order - b.order);
    [...listed, ...rest].forEach((s, i) => { s.order = i; });
    return this.list();
  }

  _nextOrder() {
    let max = -1;
    for (const s of this.sessions.values()) if (s.order > max) max = s.order;
    return max + 1;
  }

  get(id) {
    const s = this.sessions.get(id);
    return s ? this._toJson(s) : null;
  }

  // 寫 bytes 進 PTY stdin（給 /input route 用）
  // 回傳：null = session 不存在；false = session 已結束；true = 成功 write
  write(id, bytes) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status !== 'running' || !s._pty) return false;
    s._pty.write(bytes);
    return true;
  }

  // 給 JSON /log API 用：取最後 N 個 chunk、concat 後 decode 成 utf8 string
  // 注意：lines 參數是「最近 N 個 PTY chunk」，不是真正的「行數」（歷史遺留命名）
  logTail(id, lines = 200) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const ring = s.output_ring;
    const tail = ring.slice(Math.max(0, ring.length - lines));
    return Buffer.concat(tail).toString('utf8');
  }

  async spawn({ profile_id, cols, rows } = {}) {
    const profile = this.profiles.get(profile_id);
    if (!profile) {
      const err = new Error(`launch profile not found: ${profile_id}`);
      err.status = 404;
      throw err;
    }

    const id = randomUUID();
    const cwd = expandHome(profile.cwd);
    if (!existsSync(cwd)) {
      const err = new Error(`cwd does not exist: ${cwd}`);
      err.status = 422;
      throw err;
    }

    const logPath = join(this.logDir, `${id}.log`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    const safeEnv = Object.fromEntries(
      SAFE_ENV_KEYS
        .map(k => [k, process.env[k]])
        .filter(([, v]) => typeof v === 'string')
    );
    const env = {
      ...safeEnv,
      ...sanitizeProfileEnv(profile.env),
      CODD_TERMINAL_ID: id,
      TERM: 'xterm-256color',
    };

    const size = {
      cols: clampDim(cols, COLS_MIN, COLS_MAX, DEFAULT_COLS),
      rows: clampDim(rows, ROWS_MIN, ROWS_MAX, DEFAULT_ROWS),
    };
    const spawnCmd = buildSpawnCommand(profile.command, id);

    // encoding: null → onData 回 Buffer，整條路（log / ring / SSE base64）
    // 都不做 string 解碼，避免 multi-byte UTF-8（box drawing、emoji、ellipsis 等）
    // 被截 byte。xterm.js 端自己會做 UTF-8 + ANSI escape 的跨 chunk 拼接。
    const ptyProcess = pty.spawn(
      this.shell,
      ['-i', '-c', spawnCmd.command],
      { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env, encoding: null }
    );

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50); // 允許多個 SSE client 同時訂閱

    // 讓 kill() 可以 await PTY 真的死掉
    let resolveExit;
    const exitPromise = new Promise(r => { resolveExit = r; });

    const record = {
      id,
      profile_id: profile.id,
      profile_name: profile.name,
      command: profile.command,
      cwd,
      pid: ptyProcess.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      exited_at: null,
      exit_code: null,
      restart_count: 0,
      removed: false,
      // 新開的接在列表最後，既有 session 的位置（和 Alt+數字）不會跟著位移
      order: this._nextOrder(),
      cols: size.cols,
      rows: size.rows,
      controller_client_id: null,
      claude_session_id: spawnCmd.claude_session_id,
      log_path: logPath,
      output_ring: [],
      _ring_bytes: 0,
      _pty: ptyProcess,
      _logStream: logStream,
      _emitter: emitter,
      _exitPromise: exitPromise,
      _killing: false,
    };

    ptyProcess.onData(chunk => {
      // chunk 此處保證是 Buffer（spawn 時 encoding: null）
      logStream.write(chunk);
      const ring = record.output_ring;
      ring.push(chunk);
      record._ring_bytes += chunk.length;
      // 至少留最新一個 chunk，其餘從最舊的開始丟
      let drop = 0;
      while (ring.length - drop > 1
        && (ring.length - drop > RING_MAX || record._ring_bytes > RING_MAX_BYTES)) {
        record._ring_bytes -= ring[drop].length;
        drop++;
      }
      if (drop) ring.splice(0, drop);
      emitter.emit('data', chunk);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      record.status = 'exited';
      record.exited_at = new Date().toISOString();
      record.exit_code = signal ? `signal:${signal}` : exitCode;
      record._pty = null;
      try { logStream.end(); } catch {}
      emitter.emit('exit', { exitCode, signal });
      resolveExit({ exitCode, signal });
    });

    this.sessions.set(id, record);
    return this._toJson(record);
  }

  async kill(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status !== 'running' || !s._pty) return this._toJson(s);

    // 已經在收尾就接著等同一個 exitPromise，不要重發訊號
    if (!s._killing) {
      s._killing = true;
      try { s._pty.kill('SIGTERM'); } catch {}
    }

    // 階段 1：等 graceful exit
    await this._waitExitOrTimeout(s, KILL_TERM_TIMEOUT_MS);

    // 階段 2：還活著就升級成 SIGKILL，再給一點時間讓 kernel reap
    if (s.status === 'running' && s._pty) {
      try { s._pty.kill('SIGKILL'); } catch {}
      await this._waitExitOrTimeout(s, KILL_FORCE_TIMEOUT_MS);
    }
    return this._toJson(s);
  }

  _waitExitOrTimeout(s, ms) {
    let to;
    const timer = new Promise(r => { to = setTimeout(r, ms); });
    return Promise.race([s._exitPromise, timer]).finally(() => clearTimeout(to));
  }

  // soft-delete：從預設列表移除（保留在 Map 供 filter 顯示）。
  // 若還在跑就先 kill 乾淨，避免出現「隱藏但仍在跑」的殭屍 session。
  async remove(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status === 'running') await this.kill(id);
    s.removed = true;
    return this._toJson(s);
  }

  async restart(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status === 'running') await this.kill(id);
    // 沿用舊 PTY 的尺寸，避免新 session 先以預設 120×30 畫一輪再被 resize
    const fresh = await this.spawn({ profile_id: s.profile_id, cols: s.cols, rows: s.rows });
    const freshRec = this.sessions.get(fresh.id);
    freshRec.restart_count = (s.restart_count || 0) + 1;
    // 重開的 session 留在原本的位置
    freshRec.order = s.order;
    return this._toJson(freshRec);
  }

  // 多台裝置看同一個 PTY 時，PTY 尺寸跟著「最後操作的那台」走（controller_client_id）。
  // 回傳：null = session 不存在；已結束則原樣回傳不動。
  resize(id, cols, rows, clientId = null) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status !== 'running' || !s._pty) return this._toJson(s);

    const nextCols = clampDim(cols, COLS_MIN, COLS_MAX, s.cols);
    const nextRows = clampDim(rows, ROWS_MIN, ROWS_MAX, s.rows);
    const nextClient = clientId ?? null;
    const sizeChanged = nextCols !== s.cols || nextRows !== s.rows;
    // 同尺寸同 controller 就不重送：前端每次互動都會 claim，避免無謂的 SIGWINCH 讓 TUI 重畫
    if (!sizeChanged && nextClient === s.controller_client_id) return this._toJson(s);

    if (sizeChanged) {
      try { s._pty.resize(nextCols, nextRows); } catch {}
    }
    s.cols = nextCols;
    s.rows = nextRows;
    s.controller_client_id = nextClient;
    s._emitter.emit('resize', { cols: nextCols, rows: nextRows, client_id: nextClient });
    return this._toJson(s);
  }

  // SSE / WebSocket 用：訂閱 PTY data + exit + resize 事件。回傳 unsubscribe 函式。
  // 若 session 不存在回傳 null（caller 應該回 404）。
  // 若 session 已 exited，仍可訂閱（但只會收到 exit 事件，不會有 data） — caller 通常先 flush ring buffer 已足夠。
  subscribe(id, { onData, onExit, onResize } = {}) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (onData) s._emitter.on('data', onData);
    if (onExit) s._emitter.on('exit', onExit);
    if (onResize) s._emitter.on('resize', onResize);
    return () => {
      if (onData) s._emitter.off('data', onData);
      if (onExit) s._emitter.off('exit', onExit);
      if (onResize) s._emitter.off('resize', onResize);
    };
  }

  // SSE catch-up 用：拿全部 ring 內容，回 Buffer 直接 base64 不解碼
  logFull(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return Buffer.concat(s.output_ring);
  }

  // 等所有 PTY 真的死掉才 resolve（並行送訊號，整體最久 = 單一 PTY 的 5s+2s）
  async killAll() {
    const tasks = [];
    for (const s of this.sessions.values()) {
      if (s.status === 'running' && s._pty) {
        tasks.push(this.kill(s.id));
      }
    }
    await Promise.all(tasks);
  }

  // 白名單輸出：內部欄位（_emitter / _exitPromise / log_path 等）不外流到 API
  _toJson(s) {
    return {
      id: s.id,
      profile_id: s.profile_id,
      profile_name: s.profile_name,
      command: s.command,
      cwd: s.cwd,
      pid: s.pid,
      status: s.status,
      started_at: s.started_at,
      exited_at: s.exited_at,
      exit_code: s.exit_code,
      restart_count: s.restart_count,
      removed: s.removed,
      order: s.order,
      cols: s.cols,
      rows: s.rows,
      controller_client_id: s.controller_client_id,
      claude_session_id: s.claude_session_id,
      output_lines: s.output_ring.length,
    };
  }
}
