// claude-accounts / codex-accounts 共用的小工具：跑子行程（逾時必殺）、email 遮罩、錯誤訊息清洗。
//
// 子行程一律 spawn(file, args)，不經 shell；自成 process group（detached），
// 逾時或 server 關機時整組收掉，避免 helper 孫行程變孤兒。

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

const KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_TTL_MS = 10 * 60_000;

/** 'alice.chen@example.com' → 'ali•••@example.com'；本地部分 ≤3 字元 → 'a•••@x.com' */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.trim()) return null;
  const s = email.trim();
  const at = s.lastIndexOf('@');
  const local = at >= 0 ? s.slice(0, at) : s;
  const domain = at >= 0 ? s.slice(at) : '';
  const chars = [...local];
  const keep = chars.length > 3 ? 3 : 1;
  return `${chars.slice(0, keep).join('')}•••${domain}`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * 給使用者看的錯誤字串：去 ANSI、遮掉任何長得像 token 的東西、截斷。
 * 外部 CLI 的 stderr 理論上不含 token，但這裡是最後一道關卡，寧可多遮。
 */
export function sanitizeMessage(input, max = 200) {
  let s = String(input ?? '');
  s = s.replace(ANSI_RE, '');
  s = s.replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g, '[已遮蔽]');
  s = s.replace(/\b(?:sk|rt|at)-[A-Za-z0-9_-]{8,}/g, '[已遮蔽]');
  s = s.replace(/((?:id|access|refresh)_token|api[_-]?key|OPENAI_API_KEY|authorization|bearer)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[已遮蔽]');
  s = s.replace(/[A-Za-z0-9_+/=-]{40,}/g, '[已遮蔽]');
  s = s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** 最後一個非空行（去 ANSI） */
export function lastLine(text) {
  const lines = String(text ?? '').replace(ANSI_RE, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** 整個 process group 一起送 signal；group 不存在（已結束 / 沒 detached）就退回只殺 child */
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* 已經不在了 */ }
  }
}

/**
 * 跑一次外部指令，永不 reject：
 *   { code, signal, stdout, stderr, timedOut, overflow, error }
 * 逾時 → SIGTERM 整組 → 2 s 後 SIGKILL。tracker（Set）會在執行期間持有 child，讓 stop() 能收掉。
 */
export function runCommand(file, args, { timeoutMs = 15_000, env = process.env, maxBytes = DEFAULT_MAX_BYTES, tracker = null } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch (error) {
      done({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, overflow: false, error });
      return;
    }
    tracker?.add(child);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let error = null;
    let finished = false;
    let killTimer = null;

    const terminate = () => {
      killTree(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref?.();

    const onData = (which) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!overflow) { overflow = true; terminate(); }
        return;
      }
      if (which === 'out') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      tracker?.delete(child);
      done({ code, signal, stdout, stderr, timedOut, overflow, error });
    };
    child.on('error', (e) => {
      error = e;
      // spawn 失敗（ENOENT / EACCES）時不一定會有 close
      if (!child.pid) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

const versionCache = new Map();

/** `<bin> --version` 解析出的版本，依執行檔路徑 + mtime 快取 10 分鐘；拿不到 null */
export async function binVersion(binPath, env) {
  if (!binPath) return null;
  let mtime = 0;
  try { mtime = statSync(binPath).mtimeMs; } catch { return null; }
  const key = `${binPath}\0${mtime}`;
  const hit = versionCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.value;
  const r = await runCommand(binPath, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, env, maxBytes: 64 * 1024 });
  const value = r.code === 0 ? parseVersion(r.stdout) ?? parseVersion(r.stderr) : null;
  versionCache.set(key, { at: Date.now(), value });
  return value;
}

/** ISO 字串；不合法 null */
export function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  // 超出 Date 可表示範圍（±8.64e15 ms）時 toISOString 會 throw RangeError
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return null;
  return new Date(t).toISOString();
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
