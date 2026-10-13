// Claude Code user-level 設定（hooks + statusLine）的引導式安裝
//
// 只做純 JSON 編輯：讀 settings → 只改 hooks[event] 與 statusLine → 備份 + atomic rename 寫回。
// 其他 key（env、permissions、別人的 hooks…）原封不動；套用兩次第二次不會有任何變更。
// 回傳給 UI / CLI 的永遠只有被動到的子樹，不回整份 settings（env 可能含 secrets）。

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  chmodSync,
  unlinkSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveStatusDir } from './status-paths.js';

export const SETUP_PARTS = ['hooks', 'statusline', 'legacy'];

// 對照 https://code.claude.com/docs/en/hooks 的 event 名稱
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

// 官方 docs：matcher 為 "*"、"" 或省略都是 match-all；不支援 matcher 的 event 會忽略它。
// tool / permission / notification 類明確寫 "*"（舊版 Claude Code 對 tool event 需要 matcher），其餘省略。
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification']);
const HOOK_TIMEOUT_SEC = 5;

const HOOK_SCRIPT_REL = 'configs/hooks/status-writer.js';
const STATUSLINE_SCRIPT_REL = 'configs/statusline/codd-statusline.js';
const HOOK_MARK = 'status-writer.js';
const STATUSLINE_MARK = 'codd-statusline.js';
const CHAIN_RE = /--chain-b64\s+([A-Za-z0-9+/=]+)/;

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export class SetupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ───────── paths / opts ─────────

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function displayPath(p) {
  if (!p) return p;
  const home = homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

function defaultSettingsPath(env) {
  if (env.CODD_CLAUDE_SETTINGS_PATH) return env.CODD_CLAUDE_SETTINGS_PATH;
  // terminal-manager 會把 server 的 CLAUDE_CONFIG_DIR 傳給 spawn 出來的 claude（SAFE_ENV_KEYS），所以裝在同一份 settings
  if (env.CLAUDE_CONFIG_DIR) return join(expandHome(env.CLAUDE_CONFIG_DIR), 'settings.json');
  return join(homedir(), '.claude', 'settings.json');
}

// Homebrew 的 process.execPath 是 Cellar 內含版本號的路徑，brew upgrade 後就失效；
// 有指向同一個 binary 的穩定 symlink 就用它（keg-only 的 node@XX 用 <prefix>/opt/<formula>）。
// nvm 沒有穩定路徑：指令本身會在 node 不見時退回原 statusline（見 statuslineCommand）
function stableNodePath(execPath) {
  try {
    const real = realpathSync(execPath);
    const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
    const keg = real.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
    if (keg) candidates.push(`${keg[1]}/opt/${keg[2]}/bin/node`);
    for (const c of candidates) {
      if (existsSync(c) && realpathSync(c) === real) return c;
    }
  } catch { /* fall through */ }
  return execPath;
}

function resolveOpts(opts = {}) {
  const env = opts.env || process.env;
  const channelRaw = opts.channelPath !== undefined ? opts.channelPath : env.CHANNEL_PATH;
  return {
    settingsPath: resolve(expandHome(opts.settingsPath || defaultSettingsPath(env))),
    statusDir: opts.statusDir ? resolve(expandHome(opts.statusDir)) : resolveStatusDir(env),
    nodePath: opts.nodePath || stableNodePath(process.execPath),
    repoRoot: resolve(expandHome(opts.repoRoot || DEFAULT_REPO_ROOT)),
    channelPath: channelRaw ? resolve(expandHome(channelRaw)) : null,
  };
}

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return resolve(a) === resolve(b); }
}

// ───────── commands ─────────

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(ctx) {
  const script = join(ctx.repoRoot, HOOK_SCRIPT_REL);
  // guard：不是 app spawn 的 session（沒有 CODD_TERMINAL_ID）連 node 都不啟動，幾乎零成本；
  // node 被 nvm / brew 移掉或 repo 搬走時也直接結束，不要每個 event 都冒 hook error
  return `[ -z "$CODD_TERMINAL_ID" ] || [ ! -x ${shq(ctx.nodePath)} ] || [ ! -f ${shq(script)} ] || `
    + `STATUS_DIR_PATH=${shq(ctx.statusDir)} ${shq(ctx.nodePath)} ${shq(script)}`;
}

// statusLine 對機器上「每個」Claude session 都會跑：node 或 script 不見時不能讓畫面整條空白，
// 退回直接跑原本的 statusline（stdin 還沒被讀，原指令拿得到同一份輸入）。
// 原指令用 /bin/sh -c + 單引號包起來，裡面有 fi / & / 換行都不會拆壞 if 結構；不用 ||，免得 chain 本身失敗時跑兩次
export function statuslineCommand(ctx, chained = null) {
  const script = join(ctx.repoRoot, STATUSLINE_SCRIPT_REL);
  const guard = `[ -x ${shq(ctx.nodePath)} ] && [ -f ${shq(script)} ]`;
  const base = `STATUS_DIR_PATH=${shq(ctx.statusDir)} ${shq(ctx.nodePath)} ${shq(script)}`;
  if (chained == null) return `if ${guard}; then ${base}; else :; fi`;
  return `if ${guard}; then ${base} --chain-b64 ${Buffer.from(chained, 'utf8').toString('base64')}; `
    + `else /bin/sh -c ${shq(chained)}; fi`;
}

// 已安裝指令裡的 node 路徑（'<node>' '<…/status-writer.js|codd-statusline.js>' 那一對）
const INSTALLED_NODE_RE = /'((?:[^']|'\\'')*)'\s+'(?:[^']|'\\'')*(?:status-writer|codd-statusline)\.js'/;
function installedNodePath(command) {
  const m = typeof command === 'string' ? command.match(INSTALLED_NODE_RE) : null;
  return m ? m[1].replace(/'\\''/g, "'") : null;
}

function decodeChain(command) {
  const m = command.match(CHAIN_RE);
  if (!m) return { chain: null, invalid: false };
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  // round-trip 不一致代表 base64 被改壞，不能拿來還原
  if (Buffer.from(decoded, 'utf8').toString('base64') !== m[1]) return { chain: null, invalid: true };
  return { chain: decoded, invalid: false };
}

// ───────── JSON helpers ─────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

// key 順序不同（例如被其他工具重排）不該被當成 outdated
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function loadJson(file) {
  if (!existsSync(file)) return { exists: false, data: {}, indent: 2, eol: true };
  const raw = readFileSync(file, 'utf8');
  const st = statSync(file);
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // V8 的錯誤訊息會帶原文片段（可能含 secrets），只留行列位置
      const pos = String(e.message).match(/line \d+ column \d+|position \d+/);
      throw new SetupError(`無法解析 JSON：${displayPath(file)}${pos ? `（${pos[0]}）` : ''}`, 422);
    }
  }
  if (!isPlainObject(data)) throw new SetupError(`${displayPath(file)} 不是 JSON object`, 422);
  const m = raw.match(/^\{\r?\n([ \t]+)\S/);
  return {
    exists: true,
    data,
    indent: m ? m[1] : 2,
    eol: raw.endsWith('\n'),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function backupPath(file) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  let candidate = `${file}.codd-bak-${stamp}`;
  for (let i = 2; existsSync(candidate); i++) candidate = `${file}.codd-bak-${stamp}-${i}`;
  return candidate;
}

// 備份放在原路徑旁；寫入走 realpath，settings.json 是 symlink（dotfiles）時不會被換成一般檔
function writeSettings(file, loaded, data) {
  const target = loaded.exists ? realpathSync(file) : file;
  let mode = 0o644;
  let backup = null;
  if (loaded.exists) {
    const st = statSync(target);
    if (st.mtimeMs !== loaded.mtimeMs || st.size !== loaded.size) {
      throw new SetupError(`${displayPath(file)} 在讀取後被其他程式修改，請重新整理後再試一次`, 409);
    }
    mode = st.mode & 0o777;
    backup = backupPath(file);
    copyFileSync(target, backup, fsConstants.COPYFILE_EXCL);
  } else {
    mkdirSync(dirname(target), { recursive: true });
  }
  const text = JSON.stringify(data, null, loaded.indent) + (loaded.eol ? '\n' : '');
  const tmp = `${target}.codd-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return backup;
}

// ───────── hooks ─────────

function isManagedHandler(h) {
  return typeof h?.command === 'string' && h.command.includes(HOOK_MARK);
}

// 同時認舊格式 { matcher, command }（舊版手動安裝）與官方 { matcher, hooks: [...] }
function groupHasManaged(group) {
  if (!isPlainObject(group)) return false;
  if (typeof group.command === 'string' && group.command.includes(HOOK_MARK)) return true;
  return Array.isArray(group.hooks) && group.hooks.some(isManagedHandler);
}

// 拿掉 group 內的 CODD handler；整組都是我們的就回 null
function stripManaged(group) {
  if (typeof group.command === 'string' && group.command.includes(HOOK_MARK)) return null;
  const rest = group.hooks.filter(h => !isManagedHandler(h));
  return rest.length ? { ...group, hooks: rest } : null;
}

function expectedGroup(event, ctx) {
  return {
    ...(MATCHER_EVENTS.has(event) ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command: hookCommand(ctx), timeout: HOOK_TIMEOUT_SEC }],
  };
}

function inspectHooks(settings, ctx) {
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const events = {};
  for (const ev of HOOK_EVENTS) {
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const managed = arr.filter(groupHasManaged);
    const expected = expectedGroup(ev, ctx);
    let state = 'outdated';
    if (!managed.length) state = 'missing';
    else if (managed.length === 1 && sameJson(managed[0], expected)) state = 'installed';
    events[ev] = { state, managed, expected, others: arr.length - managed.length };
  }
  const states = Object.values(events).map(e => e.state);
  const state = states.every(s => s === 'installed') ? 'installed'
    : states.every(s => s === 'missing') ? 'missing'
    : 'outdated';
  return {
    state,
    events,
    events_missing: HOOK_EVENTS.filter(ev => events[ev].state === 'missing'),
    events_outdated: HOOK_EVENTS.filter(ev => events[ev].state === 'outdated'),
  };
}

function installHooks(settings, ctx) {
  const info = inspectHooks(settings, ctx);
  if (info.state === 'installed') return null;
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new SetupError('settings.hooks 不是 object，請先手動修正', 422);
  }
  settings.hooks = settings.hooks || {};
  const before = {};
  const after = {};
  const added = [];
  const updated = [];
  let kept = 0;
  for (const ev of HOOK_EVENTS) {
    const e = info.events[ev];
    kept += e.others;
    if (e.state === 'installed') continue;
    const current = settings.hooks[ev];
    if (current !== undefined && !Array.isArray(current)) {
      throw new SetupError(`settings.hooks.${ev} 不是陣列，請先手動修正`, 422);
    }
    const next = [];
    let placed = false;
    for (const g of current || []) {
      if (!groupHasManaged(g)) { next.push(g); continue; }
      const rest = stripManaged(g);
      if (rest) next.push(rest);
      // 放回第一個舊 entry 的位置，避免每次升級都跑到陣列尾端
      if (!placed) { next.push(e.expected); placed = true; }
    }
    if (!placed) next.push(e.expected);
    settings.hooks[ev] = next;
    // 預覽只放 CODD 自己的項目（別人的 hook 指令可能含 token，不送到瀏覽器）；
    // 原本沒有 CODD 項目的 event 不放進 before，diff 才會顯示成「附加」而不是「把陣列換掉」
    const keptNote = e.others ? [`…（保留既有 ${e.others} 組 hook）`] : [];
    if (e.managed.length) before[ev] = [...keptNote, ...clone(e.managed)];
    after[ev] = [...keptNote, clone(e.expected)];
    (e.state === 'missing' ? added : updated).push(ev);
  }
  const bits = [];
  if (added.length) bits.push(`新增 ${added.length} 個 event 的 CODD hook（${added.join(', ')}）`);
  if (updated.length) bits.push(`更新 ${updated.length} 個 event 的 CODD hook（node / repo 路徑變了：${updated.join(', ')}）`);
  bits.push(kept ? `既有的其他 ${kept} 組 hook 保持不動` : '沒有其他 hook 需要保留');
  return { summary: bits.join('；'), before: { hooks: before }, after: { hooks: after } };
}

// 拿掉所有 event 底下的 CODD hook（含不在 HOOK_EVENTS 內的舊殘留）
function removeManagedHooks(settings) {
  if (!isPlainObject(settings.hooks)) return null;
  const before = {};
  const after = {};
  let kept = 0;
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const managed = arr.filter(groupHasManaged);
    kept += arr.length - managed.length;
    if (!managed.length) continue;
    const next = [];
    for (const g of arr) {
      if (!groupHasManaged(g)) { next.push(g); continue; }
      const rest = stripManaged(g);
      if (rest) next.push(rest);
    }
    before[ev] = clone(managed);
    after[ev] = [];
    if (next.length) settings.hooks[ev] = next;
    else delete settings.hooks[ev];
  }
  const events = Object.keys(before);
  if (!events.length) return null;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return {
    summary: `移除 ${events.length} 個 event 的 CODD hook（${events.join(', ')}）；其他 ${kept} 組 hook 保持不動`,
    before: { hooks: before },
    after: { hooks: after },
    events,
  };
}

function uninstallHooks(settings) {
  return removeManagedHooks(settings);
}

// ───────── statusLine ─────────

function inspectStatusline(settings, ctx) {
  const sl = settings.statusLine;
  const cmd = isPlainObject(sl) && typeof sl.command === 'string' && sl.command.trim() ? sl.command : null;
  if (cmd && cmd.includes(STATUSLINE_MARK)) {
    const { chain, invalid } = decodeChain(cmd);
    const expected = invalid ? null : statuslineCommand(ctx, chain);
    const state = !invalid && cmd === expected && sl.type === 'command' ? 'installed' : 'outdated';
    return { state, mode: chain != null || invalid ? 'wrapped' : 'standalone', has_foreign: chain != null || invalid, chain, invalid };
  }
  return { state: 'missing', mode: null, has_foreign: cmd != null, chain: cmd, invalid: false };
}

function installStatusline(settings, ctx) {
  const info = inspectStatusline(settings, ctx);
  if (info.state === 'installed') return null;
  if (info.invalid) {
    throw new SetupError('statusLine 的 --chain-b64 無法解碼，無法安全地重新包裝，請手動檢查 statusLine.command', 422);
  }
  if (settings.statusLine !== undefined && !isPlainObject(settings.statusLine)) {
    throw new SetupError('settings.statusLine 不是 object，請先手動修正', 422);
  }
  const before = clone(settings.statusLine);
  // 保留 padding / refreshInterval / hideVimModeIndicator 等其他 key
  const next = isPlainObject(settings.statusLine) ? { ...settings.statusLine } : {};
  next.type = 'command';
  next.command = statuslineCommand(ctx, info.chain);
  settings.statusLine = next;
  const summary = info.state === 'outdated'
    ? '更新 CODD statusline 的 node / repo 路徑（原本串接的 statusline 不變）'
    : info.chain != null
      ? '用 CODD statusline 包住你現有的 statusline：畫面輸出仍是原本那支，CODD 只在旁邊記錄標題與 5h/1w 用量'
      : '新增 CODD statusline（目前沒有 statusline，會顯示一行簡易狀態）';
  return { summary, before: { statusLine: before }, after: { statusLine: clone(next) } };
}

function uninstallStatusline(settings) {
  const sl = settings.statusLine;
  const cmd = isPlainObject(sl) && typeof sl.command === 'string' ? sl.command : '';
  if (!cmd.includes(STATUSLINE_MARK)) return null;
  const { chain, invalid } = decodeChain(cmd);
  if (invalid) {
    throw new SetupError('statusLine 的 --chain-b64 無法解碼，無法還原原本的 statusline，請手動處理', 422);
  }
  const before = clone(sl);
  let summary;
  if (chain != null) {
    settings.statusLine = { ...sl, command: chain };
    summary = '還原為原本串接的 statusline';
  } else {
    const rest = { ...sl };
    delete rest.type;
    delete rest.command;
    if (Object.keys(rest).length) settings.statusLine = rest;
    else delete settings.statusLine;
    summary = '移除 CODD statusline（安裝前沒有 statusline）';
  }
  return { summary, before: { statusLine: before }, after: { statusLine: clone(settings.statusLine) } };
}

// ───────── legacy（channel 級 PostToolUse hook，和 user-level 的會重複觸發）─────────

function legacyFile(ctx) {
  if (!ctx.channelPath) return null;
  const file = join(ctx.channelPath, '.claude', 'settings.json');
  // channel 剛好就是 user-level settings 時交給 hooks part 處理
  if (samePath(file, ctx.settingsPath)) return null;
  return file;
}

function inspectLegacy(ctx) {
  const file = legacyFile(ctx);
  if (!file || !existsSync(file)) return { present: false, file: file ? displayPath(file) : null, entries: 0 };
  try {
    const { data } = loadJson(file);
    const hooks = isPlainObject(data.hooks) ? data.hooks : {};
    let entries = 0;
    for (const arr of Object.values(hooks)) {
      if (Array.isArray(arr)) entries += arr.filter(groupHasManaged).length;
    }
    return { present: entries > 0, file: displayPath(file), entries };
  } catch (e) {
    return { present: false, file: displayPath(file), entries: 0, error: e.message };
  }
}

function removeLegacy(settings) {
  const res = removeManagedHooks(settings);
  if (!res) return null;
  return {
    summary: `移除 channel 級的舊 status-writer hook（${res.events.join(', ')}），避免和 user-level hook 重複觸發`,
    before: res.before,
    after: res.after,
  };
}

// ───────── data freshness ─────────

function newestMtime(dir, suffix) {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(suffix)) continue;
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* 檔案可能剛被 rename 掉 */ }
    }
  } catch { return null; }
  return newest ? new Date(newest).toISOString() : null;
}

function dataFreshness(statusDir) {
  const term = join(statusDir, 'term');
  return {
    hook_last_at: newestMtime(term, '.hook.json'),
    statusline_last_at: newestMtime(term, '.statusline.json'),
    usage_last_at: newestMtime(join(statusDir, 'usage'), '.json'),
  };
}

function installedNodePaths(settings) {
  const paths = new Set();
  const sl = settings.statusLine;
  if (isPlainObject(sl) && typeof sl.command === 'string' && sl.command.includes(STATUSLINE_MARK)) {
    const p = installedNodePath(sl.command);
    if (p) paths.add(p);
  }
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  for (const arr of Object.values(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const g of arr) {
      if (!isPlainObject(g)) continue;
      const cmds = [g.command, ...(Array.isArray(g.hooks) ? g.hooks.map(h => h?.command) : [])];
      for (const c of cmds) {
        if (typeof c !== 'string' || !c.includes(HOOK_MARK)) continue;
        const p = installedNodePath(c);
        if (p) paths.add(p);
      }
    }
  }
  return [...paths];
}

// ───────── public API ─────────

export function parseParts(input, { required = false } = {}) {
  if (input === undefined || input === null || input === '') {
    if (required) throw new SetupError(`parts 必填（${SETUP_PARTS.join(', ')}）`, 400);
    return [...SETUP_PARTS];
  }
  const raw = Array.isArray(input) ? input : [input];
  if (raw.some(p => typeof p !== 'string')) throw new SetupError(`parts 只能是 ${SETUP_PARTS.join(', ')}`, 400);
  const list = raw.flatMap(p => p.split(',')).map(s => s.trim()).filter(Boolean);
  if (!list.length || list.some(p => !SETUP_PARTS.includes(p))) {
    throw new SetupError(`parts 只能是 ${SETUP_PARTS.join(', ')}`, 400);
  }
  return SETUP_PARTS.filter(p => list.includes(p));
}

export function getSetupStatus(opts = {}) {
  const ctx = resolveOpts(opts);
  let settings = {};
  let exists = false;
  let error = null;
  try {
    const loaded = loadJson(ctx.settingsPath);
    settings = loaded.data;
    exists = loaded.exists;
  } catch (e) {
    error = e.message;
  }
  const hooks = inspectHooks(settings, ctx);
  const statusline = inspectStatusline(settings, ctx);
  const legacy = inspectLegacy(ctx);
  const warnings = [];
  if (settings.disableAllHooks === true) {
    warnings.push('settings 內 disableAllHooks 為 true：hooks 與 statusLine 都不會執行');
  }
  for (const rel of [HOOK_SCRIPT_REL, STATUSLINE_SCRIPT_REL]) {
    if (!existsSync(join(ctx.repoRoot, rel))) warnings.push(`找不到 ${rel}，請確認 repo 是最新版本`);
  }
  if (legacy.error) warnings.push(`無法讀取 channel settings：${legacy.error}`);
  // server 還跑在已刪掉的 nvm node 上時，expected 也是同一條舊路徑 → 看起來「已安裝」；直接檢查檔案在不在
  const missingNodes = installedNodePaths(settings).filter(p => !existsSync(p));
  for (const p of missingNodes) {
    warnings.push(`設定裡的 node 已不存在：${displayPath(p)}（換過 nvm / brew 版本？），hooks 與 CODD statusline 目前不會執行，請重新安裝`);
  }
  return {
    settings_path: displayPath(ctx.settingsPath),
    settings_exists: exists,
    status_dir: displayPath(ctx.statusDir),
    hooks: {
      state: hooks.state,
      events_missing: hooks.events_missing,
      events_outdated: hooks.events_outdated,
    },
    statusline: { state: statusline.state, mode: statusline.mode, has_foreign: statusline.has_foreign },
    legacy: { present: legacy.present, file: legacy.file, entries: legacy.entries },
    data: dataFreshness(ctx.statusDir),
    complete: !error && hooks.state === 'installed' && statusline.state === 'installed' && !legacy.present
      && !missingNodes.length,
    warnings,
    error,
  };
}

const INSTALLERS = { hooks: installHooks, statusline: installStatusline };
const UNINSTALLERS = { hooks: uninstallHooks, statusline: uninstallStatusline };

// 每個檔案只讀一次、在記憶體副本上套用所有 part；plan 與 apply 共用，保證預覽 = 實際寫入
function prepare(action, parts, ctx) {
  const list = parseParts(parts);
  const units = [];
  const userParts = list.filter(p => p === 'hooks' || p === 'statusline');
  if (userParts.length) {
    const loaded = loadJson(ctx.settingsPath);
    const data = clone(loaded.data);
    const fns = action === 'install' ? INSTALLERS : UNINSTALLERS;
    const changes = [];
    for (const part of userParts) {
      const ch = fns[part](data, ctx);
      if (ch) changes.push({ part, file: displayPath(ctx.settingsPath), summary: ch.summary, before: ch.before, after: ch.after });
    }
    units.push({ path: ctx.settingsPath, loaded, data, changes });
  }
  // legacy 只有「移除」這個方向；uninstall 不會把舊 hook 裝回去
  if (action === 'install' && list.includes('legacy')) {
    const file = legacyFile(ctx);
    if (file && existsSync(file)) {
      const loaded = loadJson(file);
      const data = clone(loaded.data);
      const ch = removeLegacy(data);
      const changes = ch ? [{ part: 'legacy', file: displayPath(file), summary: ch.summary, before: ch.before, after: ch.after }] : [];
      units.push({ path: file, loaded, data, changes });
    }
  }
  return { list, units };
}

function assertScripts(parts, ctx) {
  const need = [];
  if (parts.includes('hooks')) need.push(HOOK_SCRIPT_REL);
  if (parts.includes('statusline')) need.push(STATUSLINE_SCRIPT_REL);
  for (const rel of need) {
    // 腳本不存在就裝上去，statusline 會整條變空白，所以直接拒絕
    if (!existsSync(join(ctx.repoRoot, rel))) throw new SetupError(`找不到 ${rel}，無法安裝`, 409);
  }
  if (need.length && !existsSync(ctx.nodePath)) throw new SetupError(`找不到 node：${ctx.nodePath}`, 409);
}

function planFor(action, parts, opts) {
  const ctx = resolveOpts(opts);
  const { list, units } = prepare(action, parts, ctx);
  return { action, parts: list, changes: units.flatMap(u => u.changes) };
}

function commit(action, parts, opts) {
  const ctx = resolveOpts(opts);
  const list = parseParts(parts);
  if (action === 'install') assertScripts(list, ctx);
  const { units } = prepare(action, list, ctx);
  const applied = [];
  const backups = [];
  const changes = [];
  for (const u of units) {
    if (!u.changes.length) continue;
    const backup = writeSettings(u.path, u.loaded, u.data);
    if (backup) backups.push(displayPath(backup));
    for (const c of u.changes) {
      applied.push(c.part);
      changes.push(c);
    }
  }
  return {
    action,
    applied,
    unchanged: list.filter(p => !applied.includes(p)),
    backups,
    changes,
    status: getSetupStatus(opts),
  };
}

export function planSetup(parts, opts = {}) {
  return planFor('install', parts, opts);
}

export function planUninstall(parts, opts = {}) {
  return planFor('uninstall', parts, opts);
}

export function applySetup(parts, opts = {}) {
  return commit('install', parts, opts);
}

export function uninstallSetup(parts, opts = {}) {
  return commit('uninstall', parts, opts);
}
