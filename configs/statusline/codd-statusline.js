#!/usr/bin/env node
// Claude Code statusLine tap：從 statusline stdin 取 Claude 標題 / context / 5h·1w 用量寫進 STATUS_DIR，
// 再（可選）把同一份 stdin 交給原本的 statusLine command 去畫。
//
//   codd-statusline.js                       → 自己印一行簡短狀態（standalone）
//   codd-statusline.js --chain-b64 <base64>  → /bin/sh -c <原 command>，stdout 原樣轉出、exit code 跟著它
//
// 寫入：
//   term/<CODD_TERMINAL_ID>.statusline.json  只在 env 有合法 CODD_TERMINAL_ID 時（= app 開的 PTY）
//   usage/<config_key>.json                  每個 session 都寫（只要 rate_limits 有任一 window）
// 容錯：不能 throw、不碰網路、只用同步 fs，寫檔失敗也照樣畫 statusline。

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const TERMINAL_ID_RE = /^[0-9a-f-]{36}$/i;
const CHAIN_TIMEOUT_MS = 10_000;

// 與 apps/server/src/services/status-paths.js 相同的解析順序（這支 script 要能獨立執行，所以複製一份）
function resolveStatusDir() {
  if (process.env.STATUS_DIR_PATH) return resolve(process.env.STATUS_DIR_PATH);
  if (process.env.STATUS_FILE_PATH) return resolve(dirname(process.env.STATUS_FILE_PATH));
  return resolve(homedir(), '.claude/codd-status');
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return isObj(v) ? v : null;
  } catch { return null; }
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function currentDir(data) {
  return str(data.workspace?.current_dir) ?? str(data.cwd);
}

function contextLeftPct(data) {
  const cw = isObj(data.context_window) ? data.context_window : {};
  const left = num(cw.remaining_percentage);
  if (left !== null) return round1(Math.min(100, Math.max(0, left)));
  const used = num(cw.used_percentage);
  return used !== null ? round1(Math.min(100, Math.max(0, 100 - used))) : null;
}

// 文件寫 epoch 秒；保險起見也吃 epoch 毫秒 / ISO 字串，一律轉成 epoch 秒
function epochSeconds(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

function pickWindow(w) {
  if (!isObj(w)) return null;
  const used = num(w.used_percentage);
  if (used === null) return null;
  return { used_percentage: used, resets_at: epochSeconds(w.resets_at) };
}

function configDir() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  if (!d) return join(homedir(), '.claude');
  return d === '~' || d.startsWith('~/') ? join(homedir(), d.slice(1)) : resolve(d);
}

// 帳號標籤（檔名 + config_key）：不能帶出 email。
// claude-swap 的目錄是 <n>-<slugify(email)> → cswap-<n>；其他看起來像 email 的改用目錄 hash
function configKey() {
  if (!process.env.CLAUDE_CONFIG_DIR) return 'default';
  const base = basename(configDir());
  const cswap = /^(\d+)-/.exec(base);
  if (cswap) return `cswap-${cswap[1]}`;
  if (base.includes('@') || /_[A-Za-z0-9-]+\.[A-Za-z]{2,}$/.test(base)) {
    return `cfg-${createHash('sha256').update(configDir()).digest('hex').slice(0, 8)}`;
  }
  const key = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return /^\.*$/.test(key) ? 'default' : key;
}

function writeTerm(statusDir, data) {
  const id = process.env.CODD_TERMINAL_ID;
  if (!id || !TERMINAL_ID_RE.test(id)) return;
  writeAtomic(join(statusDir, 'term', `${id}.statusline.json`), {
    v: 1,
    codd_terminal_id: id,
    config_dir: configDir(),
    session_id: str(data.session_id),
    session_name: str(data.session_name),
    transcript_path: str(data.transcript_path),
    cwd: currentDir(data),
    context_left_pct: contextLeftPct(data),
    model: str(data.model?.display_name),
    captured_at: new Date().toISOString(),
  });
}

// 回傳寫進去的 snapshot（standalone 模式拿來印 5h 剩餘），沒有 rate_limits 就 null
function writeUsage(statusDir, data) {
  const rl = isObj(data.rate_limits) ? data.rate_limits : null;
  if (!rl) return null;
  let fiveHour = pickWindow(rl.five_hour);
  let sevenDay = pickWindow(rl.seven_day);
  if (!fiveHour && !sevenDay) return null;

  const key = configKey();
  const file = join(statusDir, 'usage', `${key}.json`);
  // Claude Code 會在 resets_at 過後把該 window 拿掉；保留上一筆已過期的 window，
  // 讓讀取端能顯示「已重置」而不是整條消失。
  if (!fiveHour || !sevenDay) {
    const prev = readJson(file);
    const nowSec = Date.now() / 1000;
    const carry = (w) => {
      const p = pickWindow(prev?.[w]);
      return p && p.resets_at !== null && p.resets_at <= nowSec ? p : null;
    };
    if (!fiveHour) fiveHour = carry('five_hour');
    if (!sevenDay) sevenDay = carry('seven_day');
  }

  const snapshot = {
    v: 1,
    config_key: key,
    captured_at: new Date().toISOString(),
    session_id: str(data.session_id),
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
  writeAtomic(file, snapshot);
  return snapshot;
}

function standaloneLine(data) {
  const parts = [];
  const dir = currentDir(data);
  if (dir) parts.push(basename(dir) || dir);
  const model = str(data.model?.display_name);
  if (model) parts.push(model);
  const ctx = contextLeftPct(data);
  if (ctx !== null) parts.push(`ctx ${Math.round(ctx)}% left`);
  const five = pickWindow(data.rate_limits?.five_hour);
  if (five && (five.resets_at === null || five.resets_at * 1000 > Date.now())) {
    parts.push(`5h ${Math.round(Math.min(100, Math.max(0, 100 - five.used_percentage)))}% left`);
  }
  return parts.join(' · ');
}

function decodeChain(argv) {
  const i = argv.indexOf('--chain-b64');
  if (i < 0 || !argv[i + 1]) return null;
  try {
    const cmd = Buffer.from(argv[i + 1], 'base64').toString('utf8');
    return cmd.trim() ? cmd : null;
  } catch { return null; }
}

function runChain(cmd, input) {
  let child;
  try {
    // 自成 process group：逾時 / 被取消時連孫行程一起收，免得孤兒還握著 stdout 讓 Claude Code 等不到 EOF
    child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'], env: process.env, detached: true });
  } catch {
    process.exit(1);
  }
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); } catch {
      try { child.kill(sig); } catch {}
    }
  };
  const timer = setTimeout(() => killGroup('SIGKILL'), CHAIN_TIMEOUT_MS);
  // Claude Code 取消舊的 statusline run 時會殺我們 → 一併收掉子行程
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      killGroup(sig);
      process.exit(1);
    });
  }
  child.on('error', () => { clearTimeout(timer); process.exit(1); });
  child.on('exit', (code) => { clearTimeout(timer); process.exit(code ?? 1); });
  child.stdin.on('error', () => {}); // 原 command 不讀 stdin 時避免 EPIPE
  child.stdin.end(input);
}

let raw = Buffer.alloc(0);
try { raw = readFileSync(0); } catch {}

let data = {};
try {
  const v = JSON.parse(raw.toString('utf8'));
  if (isObj(v)) data = v;
} catch {}

const statusDir = resolveStatusDir();
try { writeTerm(statusDir, data); } catch {}
try { writeUsage(statusDir, data); } catch {}

const chain = decodeChain(process.argv.slice(2));
if (chain) {
  runChain(chain, raw);
} else {
  try { process.stdout.write(`${standaloneLine(data)}\n`); } catch {}
  process.exitCode = 0;
}
