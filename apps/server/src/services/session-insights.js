import { readFile, readdir, stat, open } from 'node:fs/promises';
import { join, resolve, basename, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { resolveStatusDir, termDir, usageDir } from './status-paths.js';

// 把 terminal.list() 的 PTY record 疊上 Claude Code 端的資料：
//   - STATUS_DIR/term/<id>.hook.json       ← configs/hooks/status-writer.js（狀態、最近 prompt、custom title）
//   - STATUS_DIR/term/<id>.statusline.json ← configs/statusline/codd-statusline.js（session_name、context）
//   - <claudeHome>/projects/**/<sid>.jsonl  ← transcript（未公開格式，只撈標題 / 最近 prompt）
//   - <claudeHome>/sessions/<pid>.json      ← Claude Code 自己的 session registry（未公開格式，沒裝 hook 時的備援）
//   （hook / statusline 檔有記 config_dir 時，另外也看 <config_dir>/projects 與 <config_dir>/sessions：cswap / profile env 換了 CLAUDE_CONFIG_DIR）
// 輸出絕不含 transcript 絕對路徑或 transcript 原文（只有標題 / prompt 字串）。

const TERMINAL_ID_RE = /^[0-9a-f-]{36}$/i;
const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
const TRANSCRIPT_CACHE_MAX = 200;
const REGISTRY_TTL_MS = 3000;
const REGISTRY_MAX_FILES = 500;
const LEGACY_TTL_MS = 5000;
const TITLE_MAX = 120;
const PROMPT_MAX = 500;
const FIRST_PROMPT_MAX = 60;
const STATES = new Set(['busy', 'waiting', 'idle', 'ended']);
const REASONS = new Set(['permission', 'question', 'plan']);
const REGISTRY_STATES = new Set(['busy', 'idle', 'waiting']);
// hook 漏掉的轉換（核准權限、Esc 中斷、turn 中 compact）只靠 registry 修正，而且只往 busy / idle 修：
// waiting 是最吵的狀態，只信 hook。差距要超過這個值才算「registry 比較新」，避開兩邊同時寫的競態
const REGISTRY_RECONCILE_TO = new Set(['busy', 'idle']);
const REGISTRY_NEWER_MARGIN_MS = 1000;
const REGISTRY_DIRS_MAX = 8;
// usage/ 底下舊版用 email 當檔名的快照（claude-swap 的目錄名）：不讀、不外流
const EMAILISH_RE = /@|_[A-Za-z0-9-]+\.[A-Za-z]{2,}$/;

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 去控制字元、壓空白、依 code point 截斷
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

function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ISO 字串 / epoch 秒 / epoch 毫秒 → ISO；不合法 → null
function toIso(v) {
  let ms = null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) ms = t;
  }
  return ms === null ? null : new Date(ms).toISOString();
}

async function readJson(file) {
  try {
    const v = JSON.parse(await readFile(file, 'utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

async function readSlice(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function expandHome(p) {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function shortenHome(p) {
  if (typeof p !== 'string' || !p) return null;
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + sep)) return `~${p.slice(home.length)}`;
  return p;
}

// Claude Code 把 cwd 編成 projects/ 底下的資料夾名：非英數一律換成 '-'
function encodeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// 由新到舊掃 custom-title / ai-title / last-prompt，只填還沒找到的欄位
function scanMeta(lines, out) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.customTitle && out.aiTitle && out.lastPrompt) return;
    const line = lines[i];
    if (!line || !(line.includes('-title') || line.includes('last-prompt'))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o)) continue;
    if (o.type === 'custom-title' && !out.customTitle) out.customTitle = cleanText(o.customTitle, TITLE_MAX);
    else if (o.type === 'ai-title' && !out.aiTitle) out.aiTitle = cleanText(o.aiTitle, TITLE_MAX);
    else if (o.type === 'last-prompt' && !out.lastPrompt) out.lastPrompt = cleanText(o.lastPrompt, PROMPT_MAX);
  }
}

// 第一則真人輸入：跳過 <command-…> / <system-reminder> 之類的包裝與 meta 訊息
function firstUserPrompt(lines) {
  for (const line of lines) {
    if (!line || !line.includes('"user"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o) || o.type !== 'user' || o.isMeta || o.isCompactSummary || o.isSidechain) continue;
    const content = o.message?.content;
    let text = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const block = content.find(b => isObj(b) && b.type === 'text' && typeof b.text === 'string');
      text = block ? block.text : null;
    }
    if (!text) continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<')) continue;
    const cleaned = cleanText(trimmed.replace(/<[^>]*>/g, ' '), FIRST_PROMPT_MAX);
    if (cleaned) return cleaned;
  }
  return null;
}

async function parseTranscript(path, size) {
  const out = { customTitle: null, aiTitle: null, lastPrompt: null, firstPrompt: null };
  const fh = await open(path, 'r');
  try {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = await readSlice(fh, tailStart, size - tailStart);
    let lines = tail.toString('utf8').split('\n');
    if (tailStart > 0) lines = lines.slice(1); // 第一行是被切斷的半行
    scanMeta(lines, out);
    if (!out.customTitle && !out.aiTitle) {
      const headLen = Math.min(size, HEAD_BYTES);
      let headLines;
      if (tailStart === 0) {
        headLines = lines;
      } else {
        headLines = (await readSlice(fh, 0, headLen)).toString('utf8').split('\n');
        if (headLen < size) headLines = headLines.slice(0, -1);
        scanMeta(headLines, out);
      }
      out.firstPrompt = firstUserPrompt(headLines);
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return out;
}

function usageWindow(w, now) {
  if (!isObj(w)) return null;
  const used = finiteNum(w.used_percentage);
  if (used === null) return null;
  const resetsIso = toIso(w.resets_at);
  const resetPassed = resetsIso !== null && now > Date.parse(resetsIso);
  if (resetPassed) {
    // window 已滾動：新的 reset 時間未知，用量歸零
    return { used_percentage: 0, remaining_percentage: 100, resets_at: resetsIso, reset_passed: true };
  }
  return {
    used_percentage: round1(used),
    remaining_percentage: round1(Math.min(100, Math.max(0, 100 - used))),
    resets_at: resetsIso,
    reset_passed: false,
  };
}

export class SessionInsights {
  constructor({
    statusDir = resolveStatusDir(),
    claudeHome = process.env.CODD_CLAUDE_HOME
      || (process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude')),
  } = {}) {
    this.statusDir = resolve(statusDir);
    this.claudeHome = resolve(claudeHome);
    this.projectRoots = [join(this.claudeHome, 'projects')];
    if (process.env.CLAUDE_CONFIG_DIR) {
      const extra = join(resolve(expandHome(process.env.CLAUDE_CONFIG_DIR)), 'projects');
      if (!this.projectRoots.includes(extra)) this.projectRoots.push(extra);
    }
    this._transcripts = new Map(); // path → { key: 'size:mtime', value }
    this._registries = new Map(); // dir → { at, items, pending }
    this._legacy = { at: 0, map: new Map(), pending: null };
  }

  async enrich(records) {
    if (!Array.isArray(records)) return [];
    return Promise.all(records.map(r => this._enrichRecord(r)));
  }

  async enrichOne(record) {
    if (!isObj(record)) return null;
    return this._enrichRecord(record);
  }

  async readUsage() {
    const dir = usageDir(this.statusDir);
    let names;
    try { names = await readdir(dir); } catch { return null; }
    let best = null;
    await Promise.all(names.filter(n => n.endsWith('.json') && !EMAILISH_RE.test(n.slice(0, -5))).map(async (name) => {
      const file = join(dir, name);
      try {
        const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        const data = JSON.parse(raw);
        if (!isObj(data)) return;
        const captured = Date.parse(data.captured_at);
        const at = Number.isFinite(captured) ? captured : st.mtimeMs;
        if (!best || at > best.at) best = { at, data, name };
      } catch {}
    }));
    if (!best) return null;
    const now = Date.now();
    const key = cleanText(best.data.config_key, 64);
    return {
      config_key: key && !EMAILISH_RE.test(key) ? key : best.name.replace(/\.json$/, ''),
      captured_at: new Date(best.at).toISOString(),
      age_seconds: Math.max(0, Math.floor((now - best.at) / 1000)),
      five_hour: usageWindow(best.data.five_hour, now),
      seven_day: usageWindow(best.data.seven_day, now),
    };
  }

  async dataFreshness() {
    const newest = async (dir, suffix) => {
      let names;
      try { names = await readdir(dir); } catch { return null; }
      let max = 0;
      await Promise.all(names.filter(n => n.endsWith(suffix)).map(async (n) => {
        try {
          const st = await stat(join(dir, n));
          if (st.isFile() && st.mtimeMs > max) max = st.mtimeMs;
        } catch {}
      }));
      return max ? new Date(max).toISOString() : null;
    };
    const tdir = termDir(this.statusDir);
    const [hook, statusline, usage] = await Promise.all([
      newest(tdir, '.hook.json'),
      newest(tdir, '.statusline.json'),
      newest(usageDir(this.statusDir), '.json'),
    ]);
    return { hook_last_at: hook, statusline_last_at: statusline, usage_last_at: usage };
  }

  async _enrichRecord(rec) {
    const id = typeof rec.id === 'string' && TERMINAL_ID_RE.test(rec.id) ? rec.id : null;
    const tdir = termDir(this.statusDir);
    const [hookRaw, slRaw] = id
      ? await Promise.all([
          readJson(join(tdir, `${id}.hook.json`)),
          readJson(join(tdir, `${id}.statusline.json`)),
        ])
      : [null, null];
    const belongs = (o) => o && (o.codd_terminal_id == null || o.codd_terminal_id === id);
    const hook = belongs(hookRaw) ? hookRaw : null;
    const sl = belongs(slRaw) ? slRaw : null;

    const claudeSessionId = str(hook?.session_id) ?? str(sl?.session_id) ?? str(rec.claude_session_id);
    const configDir = this._configDir(hook, sl);
    let tr = null;
    for (const p of this._transcriptPaths(hook, sl, rec, claudeSessionId, configDir)) {
      tr = await this._readTranscript(p);
      if (tr) break;
    }

    let title = null;
    let titleSource = 'fallback';
    const candidates = [
      [tr?.customTitle, 'custom-title'],
      [hook?.custom_title, 'custom-title'],
      [sl?.session_name, 'statusline'],
      [tr?.aiTitle, 'ai-title'],
      [tr?.firstPrompt, 'first-prompt'],
    ];
    for (const [value, source] of candidates) {
      const t = cleanText(value, TITLE_MAX);
      if (t) { title = t; titleSource = source; break; }
    }
    if (!title) {
      title = cleanText(rec.profile_name, TITLE_MAX)
        ?? cleanText(typeof rec.cwd === 'string' ? basename(rec.cwd) : null, TITLE_MAX)
        ?? 'session';
    }

    const contextLeft = finiteNum(sl?.context_left_pct);
    const out = { ...rec };
    delete out.log_path;
    delete out.transcript_path;
    for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];

    return {
      ...out,
      cwd_short: shortenHome(rec.cwd),
      title,
      title_source: titleSource,
      last_prompt: cleanText(hook?.last_prompt, PROMPT_MAX) ?? tr?.lastPrompt ?? null,
      context_left_pct: contextLeft === null ? null : round1(Math.min(100, Math.max(0, contextLeft))),
      // 有沒有收到這個 PTY 的 hook / statusline 回報：claude 跑了一陣子還是 false，
      // 代表 hook 沒裝在 claude 實際讀的設定檔、或 session 是在安裝前開的（前端據此提示）
      hook_seen: Boolean(hook),
      statusline_seen: Boolean(sl),
      activity: await this._activity(rec, hook, claudeSessionId, configDir),
    };
  }

  async _activity(rec, hook, claudeSessionId, configDir) {
    const hookTool = str(hook?.last_tool);
    const toolCount = Number.isInteger(hook?.tool_count) && hook.tool_count >= 0 ? hook.tool_count : null;
    if (rec.status === 'exited') {
      return { state: 'ended', since: toIso(rec.exited_at), reason: null, last_tool: hookTool, tool_count: toolCount, source: null };
    }
    const lastTool = hookTool ?? await this._legacyLastTool(rec.id);

    if (hook && STATES.has(hook.state)) {
      // hook 說 ended 但 PTY 還活著 = claude 結束、回到 shell → 視為 idle
      const state = hook.state === 'ended' ? 'idle' : hook.state;
      const activity = {
        state,
        since: toIso(hook.state_since),
        reason: state === 'waiting' && REASONS.has(hook.waiting_reason) ? hook.waiting_reason : null,
        last_tool: lastTool,
        tool_count: toolCount,
        source: 'hook',
      };
      // 有些轉換沒有 hook：核准權限後到 PostToolUse 之前、Esc 中斷（不會有 Stop）、turn 中自動 compact。
      // registry 有比 hook 更新、且不同的 busy / idle 就以它為準。
      if (hook.state !== 'ended') {
        const reg = await this._registryMatch(rec, claudeSessionId, configDir);
        const hookAt = Date.parse(hook.last_event_at);
        const regAtIso = toIso(reg?.statusUpdatedAt);
        if (reg && REGISTRY_RECONCILE_TO.has(reg.status) && reg.status !== state && regAtIso
          && Number.isFinite(hookAt) && Date.parse(regAtIso) > hookAt + REGISTRY_NEWER_MARGIN_MS) {
          return { ...activity, state: reg.status, reason: null, since: regAtIso, source: 'registry' };
        }
      }
      return activity;
    }

    const reg = await this._registryMatch(rec, claudeSessionId, configDir);
    if (reg) {
      const state = REGISTRY_STATES.has(reg.status) ? reg.status : 'unknown';
      return { state, since: toIso(reg.statusUpdatedAt), reason: null, last_tool: lastTool, tool_count: toolCount, source: 'registry' };
    }
    return { state: 'unknown', since: null, reason: null, last_tool: lastTool, tool_count: toolCount, source: null };
  }

  // writer 記下的 CLAUDE_CONFIG_DIR（只在 server 內部用，不會出現在 API 輸出）
  _configDir(hook, sl) {
    const d = str(hook?.config_dir) ?? str(sl?.config_dir);
    return d && isAbsolute(d) ? resolve(d) : null;
  }

  // configDir / sessionId：只對這筆 record 額外放行 <configDir>/projects 底下、檔名剛好是 <sessionId>.jsonl 的 transcript
  _allowedTranscript(p, configDir = null, sessionId = null) {
    if (typeof p !== 'string' || !p) return null;
    const abs = resolve(p);
    if (!abs.endsWith('.jsonl')) return null;
    if (this.projectRoots.some(root => abs.startsWith(root + sep))) return abs;
    if (configDir && sessionId && CLAUDE_SESSION_ID_RE.test(sessionId)
      && basename(abs) === `${sessionId}.jsonl`
      && abs.startsWith(join(configDir, 'projects') + sep)) return abs;
    return null;
  }

  _transcriptPaths(hook, sl, rec, claudeSessionId, configDir) {
    const candidates = [
      [str(hook?.transcript_path), str(hook?.session_id)],
      [str(sl?.transcript_path), str(sl?.session_id)],
    ];
    if (typeof rec.cwd === 'string' && rec.cwd && claudeSessionId && CLAUDE_SESSION_ID_RE.test(claudeSessionId)) {
      const rel = join('projects', encodeProjectDir(rec.cwd), `${claudeSessionId}.jsonl`);
      if (configDir) candidates.push([join(configDir, rel), claudeSessionId]);
      candidates.push([join(this.claudeHome, rel), null]);
    }
    const out = [];
    for (const [p, sid] of candidates) {
      const ok = this._allowedTranscript(p, configDir, sid);
      if (ok && !out.includes(ok)) out.push(ok);
    }
    return out;
  }

  async _readTranscript(path) {
    let st;
    try { st = await stat(path); } catch { return null; }
    if (!st.isFile()) return null;
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = this._transcripts.get(path);
    if (hit && hit.key === key) return hit.value;
    let value = null;
    try { value = await parseTranscript(path, st.size); } catch { value = null; }
    this._transcripts.delete(path);
    this._transcripts.set(path, { key, value });
    if (this._transcripts.size > TRANSCRIPT_CACHE_MAX) {
      this._transcripts.delete(this._transcripts.keys().next().value);
    }
    return value;
  }

  async _registryMatch(rec, claudeSessionId, configDir = null) {
    const homes = [this.claudeHome];
    if (configDir && configDir !== this.claudeHome) homes.push(configDir);
    for (const home of homes) {
      const items = await this._loadRegistry(join(home, 'sessions'));
      const hit = items.find(e => (Number.isInteger(rec.pid) && e.pid === rec.pid)
        || (claudeSessionId && e.sessionId === claudeSessionId));
      if (hit) return hit;
    }
    return null;
  }

  // <dir>/<pid>.json：Claude Code 未公開的 registry → 只取需要的欄位、每個目錄 3 秒快取
  async _loadRegistry(dir) {
    let cache = this._registries.get(dir);
    if (!cache) {
      if (this._registries.size >= REGISTRY_DIRS_MAX) this._registries.delete(this._registries.keys().next().value);
      cache = { at: 0, items: [], pending: null };
      this._registries.set(dir, cache);
    }
    if (Date.now() - cache.at < REGISTRY_TTL_MS) return cache.items;
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      let items = [];
      try {
        const names = (await readdir(dir)).filter(n => /^\d+\.json$/.test(n)).slice(0, REGISTRY_MAX_FILES);
        const all = await Promise.all(names.map(n => readJson(join(dir, n))));
        items = all.filter(Boolean).map(o => ({
          pid: Number.isInteger(o.pid) ? o.pid : null,
          sessionId: str(o.sessionId),
          status: str(o.status),
          statusUpdatedAt: o.statusUpdatedAt ?? o.updatedAt ?? null,
        }));
      } catch {}
      cache.items = items;
      cache.at = Date.now();
      cache.pending = null;
      return items;
    })();
    return cache.pending;
  }

  // 舊版 PostToolUse hook 寫的 STATUS_DIR/<session_id>.json：只拿來補 last_tool
  async _legacyLastTool(terminalId) {
    if (!terminalId) return null;
    const cache = this._legacy;
    if (Date.now() - cache.at >= LEGACY_TTL_MS) {
      if (!cache.pending) {
        cache.pending = (async () => {
          const map = new Map();
          try {
            const names = (await readdir(this.statusDir)).filter(n => n.endsWith('.json'));
            await Promise.all(names.map(async (n) => {
              const file = join(this.statusDir, n);
              try {
                const [data, st] = await Promise.all([readJson(file), stat(file)]);
                const key = str(data?.codd_terminal_id);
                const tool = str(data?.last_tool);
                if (!key || !tool) return;
                const prev = map.get(key);
                if (!prev || st.mtimeMs > prev.mtime) map.set(key, { tool, mtime: st.mtimeMs });
              } catch {}
            }));
          } catch {}
          cache.map = map;
          cache.at = Date.now();
          cache.pending = null;
        })();
      }
      await cache.pending;
    }
    return cache.map.get(terminalId)?.tool ?? null;
  }
}
