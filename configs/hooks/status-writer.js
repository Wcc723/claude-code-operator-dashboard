#!/usr/bin/env node
// Claude Code hook → 寫「這個 app 開的 PTY」目前狀態到 STATUS_DIR/term/<CODD_TERMINAL_ID>.hook.json（v2）
//
// 安裝：`npm run setup -- install`（user-level ~/.claude/settings.json，掛 SessionStart / UserPromptSubmit /
//       PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / Notification / Stop / StopFailure / SessionEnd）。
//       舊的 channel 級 PostToolUse 安裝（同一個 script 路徑）照樣能跑，只是只收得到 PostToolUse。
// 只處理 env 帶 CODD_TERMINAL_ID 的 session（= 由 app spawn 的 PTY），其餘直接 exit 0。
// 容錯：無論 stdin 是什麼都不能 throw、不能卡住，否則會擋住 Claude Code。

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const TERMINAL_ID_RE = /^[0-9a-f-]{36}$/i;
const PROMPT_MAX = 500;
const TITLE_MAX = 200;

// 與 apps/server/src/services/status-paths.js 相同的解析順序（這支 script 要能獨立執行，所以複製一份）
function resolveStatusDir() {
  if (process.env.STATUS_DIR_PATH) return resolve(process.env.STATUS_DIR_PATH);
  if (process.env.STATUS_FILE_PATH) return resolve(dirname(process.env.STATUS_FILE_PATH));
  return resolve(homedir(), '.claude/codd-status');
}

// 這個 claude 實際用的設定目錄（cswap / profile env 會換 CLAUDE_CONFIG_DIR）：
// server 靠它找 <dir>/projects 的 transcript 與 <dir>/sessions 的 registry
function configDir() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  if (!d) return join(homedir(), '.claude');
  return d === '~' || d.startsWith('~/') ? join(homedir(), d.slice(1)) : resolve(d);
}

function readStdin() {
  try { return readFileSync(0).toString('utf8'); } catch { return ''; }
}

function safeParse(s) {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function loadPrev(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    // prompt 可能含私人內容 → 只給擁有者讀
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// 去控制字元、壓空白、依 code point 截斷（不切壞 emoji / 中文）
function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

function setState(next, prev, state, reason, now) {
  next.state = state;
  next.waiting_reason = state === 'waiting' ? (reason || null) : null;
  if (prev.state !== state || !next.state_since) next.state_since = now;
}

// AskUserQuestion / ExitPlanMode 都是「等使用者」而不是「在忙」
function toolWaitReason(tool) {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan';
  return null;
}

function applyEvent(prev, p, terminalId, now) {
  const event = str(p.hook_event_name);
  const sessionId = str(p.session_id);

  // 巢狀 claude（例如 session 裡用 Bash 跑 `claude -p`）會繼承 CODD_TERMINAL_ID。
  // 正牌 session 換 id 時：/clear、/resume 會先送 SessionEnd（state=ended 就放行），/branch 是 SessionStart(fork)。
  // 'resume' 不算接管：巢狀的 `claude -p --resume/-c` 也是 resume，放行就會蓋掉主 session 的狀態。
  if (prev.session_id && sessionId && sessionId !== prev.session_id && prev.state !== 'ended') {
    const takeover = event === 'SessionStart' && (p.source === 'clear' || p.source === 'fork');
    if (!takeover) return null;
  }
  const sameSession = !sessionId || sessionId === prev.session_id;

  const next = {
    v: 2,
    codd_terminal_id: terminalId,
    config_dir: configDir(),
    session_id: sessionId ?? prev.session_id ?? null,
    transcript_path: str(p.transcript_path) ?? (sameSession ? prev.transcript_path : null) ?? null,
    cwd: str(p.cwd) ?? prev.cwd ?? null,
    event: event ?? prev.event ?? null,
    state: prev.state ?? null,
    state_since: prev.state_since ?? null,
    waiting_reason: prev.waiting_reason ?? null,
    last_event_at: now,
    last_tool: prev.last_tool ?? null,
    tool_count: Number.isInteger(prev.tool_count) && prev.tool_count >= 0 ? prev.tool_count : 0,
    // 換了 session（/clear、/resume）→ 舊的 prompt / 標題不屬於新 session
    last_prompt: sameSession ? (prev.last_prompt ?? null) : null,
    last_prompt_at: sameSession ? (prev.last_prompt_at ?? null) : null,
    custom_title: sameSession ? (prev.custom_title ?? null) : null,
  };

  const tool = str(p.tool_name);
  const sessionTitle = cleanText(p.session_title, TITLE_MAX);

  switch (event) {
    case 'SessionStart':
      // 自動 compact 可能發生在 turn 中間，Claude 之後還會繼續做事：維持原狀態，交給下一個 event / Stop
      if (p.source !== 'compact' || !prev.state) setState(next, prev, 'idle', null, now);
      if (sessionTitle) next.custom_title = sessionTitle;
      if (p.source === 'clear') next.tool_count = 0;
      break;
    case 'UserPromptSubmit': {
      setState(next, prev, 'busy', null, now);
      const prompt = cleanText(p.prompt, PROMPT_MAX);
      if (prompt) {
        next.last_prompt = prompt;
        next.last_prompt_at = now;
      }
      if (sessionTitle) next.custom_title = sessionTitle;
      break;
    }
    case 'PreToolUse': {
      const reason = toolWaitReason(tool);
      setState(next, prev, reason ? 'waiting' : 'busy', reason, now);
      if (tool) next.last_tool = tool;
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      setState(next, prev, 'busy', null, now);
      if (tool) next.last_tool = tool;
      next.tool_count += 1;
      break;
    case 'PermissionRequest':
      setState(next, prev, 'waiting', toolWaitReason(tool) || 'permission', now);
      if (tool) next.last_tool = tool;
      break;
    case 'Notification': {
      const type = str(p.notification_type);
      if (type === 'permission_prompt') setState(next, prev, 'waiting', 'permission', now);
      else if (type === 'elicitation_dialog' || type === 'elicitation_url_dialog') setState(next, prev, 'waiting', 'question', now);
      else if (type === 'idle_prompt') setState(next, prev, 'idle', null, now);
      else if (!type && /permission/i.test(str(p.message) || '')) setState(next, prev, 'waiting', 'permission', now);
      break;
    }
    case 'Stop':
    case 'StopFailure':
      setState(next, prev, 'idle', null, now);
      break;
    case 'SessionEnd':
      setState(next, prev, 'ended', null, now);
      break;
    default:
      break;
  }
  return next;
}

try {
  const terminalId = process.env.CODD_TERMINAL_ID;
  if (terminalId && TERMINAL_ID_RE.test(terminalId)) {
    const payload = safeParse(readStdin());
    const file = join(resolveStatusDir(), 'term', `${terminalId}.hook.json`);
    const next = applyEvent(loadPrev(file), payload, terminalId, new Date().toISOString());
    if (next) writeAtomic(file, next);
  }
} catch {
  // hook 絕不能擋住 session
}

process.exit(0);
