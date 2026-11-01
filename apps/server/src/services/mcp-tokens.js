import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync,
  readFileSync, readdirSync, statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

// CODD artifact MCP 的 bearer token 管理。
// - 每個 CODD 開的 PTY 一組 token（issue / revoke），只放記憶體：server 重啟時 PTY 本來就全部結束，token 跟著失效。
// - 另有一組 host token（<dataDir>/mcp-host-token），給不是 CODD 開的 Claude session 手動掛 MCP 用。
// - token 只寫進 0600 的設定檔；不寫 log、不放進 API 回應或錯誤訊息。
// - 比對一律用 SHA-256 digest + timingSafeEqual（長度固定，不會因長度不同提早結束）。
// - 另外寫一份固定內容的權限設定檔（<dataDir>/mcp/codd-artifacts.settings.json），spawn 時用 --settings 帶給 claude：
//   自動允許 mcp__codd-artifacts 的工具，使用者不必每次都在終端機按同意（CODD_ARTIFACTS_AUTO_ALLOW=0 關掉）。

const SERVER_NAME = 'codd-artifacts';
const TERMINAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const CONFIG_FILE_RE = /^[A-Za-z0-9-]{1,64}\.json$/;
const TMP_FILE_RE = /^\..+\.tmp$/;
const HOST_TOKEN_FILE = 'mcp-host-token';
// 不符合 CONFIG_FILE_RE（檔名中間有 .），cleanupStale 不會刪它
const SETTINGS_FILE = 'codd-artifacts.settings.json';
const SETTINGS_JSON = JSON.stringify({ permissions: { allow: [`mcp__${SERVER_NAME}`] } }, null, 2) + '\n';

function newToken() {
  return randomBytes(32).toString('base64url');
}

function digest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}

// 寫到同目錄的暫存檔（0600、wx 不覆蓋既有檔）再 rename：讀的人不會看到寫一半的檔
function atomicWrite(path, dir, content) {
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  // umask 只會拿掉權限、不會加；這裡保險再 chmod 一次
  try { chmodSync(path, 0o600); } catch {}
}

function loopbackHost(host) {
  const h = String(host ?? '').trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  // IPv6 位址放進 URL 要加中括號
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

export class McpTokens {
  // autoAllow：spawn 時是否帶 --settings 自動允許 artifact 工具（index.js 依 CODD_ARTIFACTS_AUTO_ALLOW 決定）
  constructor({ dataDir, port, host, autoAllow = true } = {}) {
    if (!dataDir) throw new Error('McpTokens: dataDir is required');
    this.dataDir = resolve(dataDir);
    this.dir = join(this.dataDir, 'mcp');
    this.port = Number(port);
    this.host = host;
    this.autoAllow = autoAllow !== false;
    this._byTerminal = new Map(); // terminalId → sha256(token)
    this._hostCache = null;       // { digest, mtimeMs, size }
    this._ensureDir();
  }

  get url() {
    return `http://${loopbackHost(this.host)}:${this.port}/api/mcp`;
  }

  get hostTokenPath() {
    return join(this.dataDir, HOST_TOKEN_FILE);
  }

  get settingsPath() {
    return join(this.dir, SETTINGS_FILE);
  }

  // 確保權限設定檔存在且內容正確（被刪或被改就重寫）→ 路徑；autoAllow 關掉時回 null。
  // 內容固定、不含 token，所有 session 共用同一份
  ensureSettings() {
    if (!this.autoAllow) return null;
    const path = this.settingsPath;
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch {}
    if (current !== SETTINGS_JSON) {
      this._ensureDir();
      atomicWrite(path, this.dir, SETTINGS_JSON);
    }
    return path;
  }

  configPathFor(terminalId) {
    if (typeof terminalId !== 'string' || !TERMINAL_ID_RE.test(terminalId)) {
      throw new Error('McpTokens: invalid terminal id');
    }
    return join(this.dir, `${terminalId}.json`);
  }

  _ensureDir() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch {}
  }

  _configJson(token) {
    return JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: this.url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2) + '\n';
  }

  // 發一組新 token 給這個 PTY，寫出 claude --mcp-config 要讀的設定檔。同一個 id 重發會換掉舊 token。
  issue(terminalId) {
    const configPath = this.configPathFor(terminalId);
    this._ensureDir();
    const token = newToken();
    atomicWrite(configPath, this.dir, this._configJson(token));
    this._byTerminal.set(terminalId, digest(token));
    return { token, configPath };
  }

  revoke(terminalId) {
    if (typeof terminalId !== 'string' || !TERMINAL_ID_RE.test(terminalId)) return false;
    const had = this._byTerminal.delete(terminalId);
    try { unlinkSync(this.configPathFor(terminalId)); } catch {}
    return had;
  }

  // → { terminalId }（CODD 開的 session）| { terminalId: null }（host token）| null（不認得）
  resolve(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const d = digest(token);
    // 全部比過一輪再回傳，不在第一個命中時提早離開
    let found;
    for (const [terminalId, known] of this._byTerminal) {
      if (timingSafeEqual(d, known) && found === undefined) found = terminalId;
    }
    const host = this._hostDigest();
    const hostHit = host ? timingSafeEqual(d, host) : false;
    if (found !== undefined) return { terminalId: found };
    if (hostHit) return { terminalId: null };
    return null;
  }

  // 惰性建立 host token；之後一直沿用同一個（刪掉檔案 = 撤銷，下次呼叫會重建新的）
  hostToken() {
    const existing = this._readHostToken();
    if (existing) return existing;
    mkdirSync(this.dataDir, { recursive: true });
    const token = newToken();
    atomicWrite(this.hostTokenPath, this.dataDir, token + '\n');
    this._hostCache = null;
    return token;
  }

  _readHostToken() {
    let raw;
    try { raw = readFileSync(this.hostTokenPath, 'utf8'); } catch { return null; }
    const token = raw.trim();
    if (!TOKEN_RE.test(token)) return null;
    // 舊檔權限太寬就收緊
    try {
      const st = statSync(this.hostTokenPath);
      if ((st.mode & 0o077) !== 0) chmodSync(this.hostTokenPath, 0o600);
    } catch {}
    return token;
  }

  // 檔案沒變（mtime + size）就用快取的 digest；檔案被刪掉 = host token 失效
  _hostDigest() {
    let st;
    try { st = statSync(this.hostTokenPath); } catch { this._hostCache = null; return null; }
    const c = this._hostCache;
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.digest;
    const token = this._readHostToken();
    if (!token) { this._hostCache = null; return null; }
    this._hostCache = { digest: digest(token), mtimeMs: st.mtimeMs, size: st.size };
    return this._hostCache.digest;
  }

  // 啟動時清掉上次留下的設定檔（那些 PTY 都已經不在了，token 也只存在上一個 process 的記憶體裡）
  cleanupStale() {
    this._ensureDir();
    let names = [];
    try { names = readdirSync(this.dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!CONFIG_FILE_RE.test(name) && !TMP_FILE_RE.test(name)) continue;
      const terminalId = name.endsWith('.json') ? name.slice(0, -5) : null;
      // 這個 process 自己發出去、還在用的不刪
      if (terminalId && this._byTerminal.has(terminalId)) continue;
      try { unlinkSync(join(this.dir, name)); removed++; } catch {}
    }
    return removed;
  }
}
