import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { tlog, tstart, recordPtyChunk, endPtyStats } from './trace.js';

const RING_MAX = 2000;

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
    return [...this.sessions.values()].map(s => this._toJson(s));
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

  async spawn({ profile_id }) {
    const spawnTrace = tstart('spawn');
    tlog('spawn', `→ profile_id=${profile_id}`);

    const profile = this.profiles.get(profile_id);
    if (!profile) {
      tlog('spawn', `✗ profile ${profile_id} not found`);
      const err = new Error(`launch profile not found: ${profile_id}`);
      err.status = 404;
      throw err;
    }
    tlog('spawn', `profile loaded`, { name: profile.name, command: profile.command.slice(0, 80), cwd: profile.cwd });

    const id = randomUUID();
    const cwd = expandHome(profile.cwd);
    const cwdT = tstart('spawn');
    if (!existsSync(cwd)) {
      tlog('spawn', `✗ cwd does not exist: ${cwd}`);
      const err = new Error(`cwd does not exist: ${cwd}`);
      err.status = 422;
      throw err;
    }
    cwdT.end({ stage: 'cwd-exists-check' });

    const logPath = join(this.logDir, `${id}.log`);
    const logT = tstart('spawn');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logT.end({ stage: 'createWriteStream' });

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

    // encoding: null → onData 回 Buffer，整條路（log / ring / SSE base64）
    // 都不做 string 解碼，避免 multi-byte UTF-8（box drawing、emoji、ellipsis 等）
    // 被截 byte。xterm.js 端自己會做 UTF-8 + ANSI escape 的跨 chunk 拼接。
    tlog('spawn', `→ pty.spawn ${this.shell} -i -c ...`);
    const ptyT = tstart('spawn');
    const ptyProcess = pty.spawn(
      this.shell,
      ['-i', '-c', profile.command],
      { name: 'xterm-256color', cols: 120, rows: 30, cwd, env, encoding: null }
    );
    ptyT.end({ stage: 'pty.spawn-call', pid: ptyProcess.pid });

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
      log_path: logPath,
      output_ring: [],
      _pty: ptyProcess,
      _logStream: logStream,
      _emitter: emitter,
      _exitPromise: exitPromise,
      _killing: false,
    };

    let firstChunkLogged = false;
    ptyProcess.onData(chunk => {
      // chunk 此處保證是 Buffer（spawn 時 encoding: null）
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        tlog('pty', `${id.slice(0, 8)} first chunk ${chunk.length} bytes`);
      }
      recordPtyChunk(id, chunk.length);

      const ok = logStream.write(chunk);
      // backpressure 偵測：write 回 false 代表 stream buffer 滿，下次 write 前要等 'drain'
      if (!ok) {
        tlog('pty', `⚠️  ${id.slice(0, 8)} logStream backpressure (buffer full)`);
      }

      record.output_ring.push(chunk);
      if (record.output_ring.length > RING_MAX) {
        record.output_ring.splice(0, record.output_ring.length - RING_MAX);
      }
      emitter.emit('data', chunk);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      tlog('pty', `${id.slice(0, 8)} exit code=${exitCode} signal=${signal ?? '-'}`);
      endPtyStats(id);
      record.status = 'exited';
      record.exited_at = new Date().toISOString();
      record.exit_code = signal ? `signal:${signal}` : exitCode;
      record._pty = null;
      try { logStream.end(); } catch {}
      emitter.emit('exit', { exitCode, signal });
      resolveExit({ exitCode, signal });
    });

    this.sessions.set(id, record);
    spawnTrace.end({ id: id.slice(0, 8), pid: ptyProcess.pid, totalSessions: this.sessions.size });
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

  async restart(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.status === 'running') await this.kill(id);
    const fresh = await this.spawn({ profile_id: s.profile_id });
    const freshRec = this.sessions.get(fresh.id);
    freshRec.restart_count = (s.restart_count || 0) + 1;
    return this._toJson(freshRec);
  }

  // SSE / WebSocket 用：訂閱 PTY data + exit 事件。回傳 unsubscribe 函式。
  // 若 session 不存在回傳 null（caller 應該回 404）。
  // 若 session 已 exited，仍可訂閱（但只會收到 exit 事件，不會有 data） — caller 通常先 flush ring buffer 已足夠。
  subscribe(id, { onData, onExit }) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (onData) s._emitter.on('data', onData);
    if (onExit) s._emitter.on('exit', onExit);
    return () => {
      if (onData) s._emitter.off('data', onData);
      if (onExit) s._emitter.off('exit', onExit);
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

  _toJson(s) {
    const { _pty, _logStream, output_ring, ...rest } = s;
    return { ...rest, output_lines: output_ring.length };
  }
}
