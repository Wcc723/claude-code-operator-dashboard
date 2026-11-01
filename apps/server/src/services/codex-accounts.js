// Codex 帳號：剩餘用量探測 + 本機帳號庫（vault）+ 快速切換。
//
// 用量：spawn `codex app-server`（stdio JSON-RPC，一行一個 JSON），問 account/read 與 account/rateLimits/read，
// 拿到就收掉。codex 沒有「列出所有帳號」的概念，所以自己維護 vault：
//   <vault>/<account_id>.json = { id, label, email, plan, saved_at, updated_at, auth: <auth.json 原始物件> }
//   <vault>/.backup/auth-<timestamp>.json   切換前的 live auth.json（只留最近 5 份）
//   <vault>/.probe/<mkdtemp>/               探測非目前帳號用的暫存 CODEX_HOME（用完即刪）
// 目錄 0700、檔案 0600，所有寫入都是「暫存檔 + rename」。
//
// 為什麼這樣探測：
//   - 目前帳號一律用真正的 CODEX_HOME 探測。vault 副本的 refresh token 可能早已被輪替掉，
//     拿它去探測會讓 codex 用失效的 token 刷新、甚至把帳號登出。探測完把 live auth.json 同步回 vault。
//   - 其他帳號在暫存 CODEX_HOME 裡探測；codex 刷新 token 時會改寫暫存的 auth.json，要寫回 vault，
//     否則下一次就拿舊 refresh token 去刷新（OpenAI 的 refresh token 只能用一次）。
//   - 探測、切換、存檔全部排進同一條序列（同時最多一個 codex app-server）：探測目前帳號時 codex
//     可能正在改寫 live auth.json，這時候切換會被它蓋回去。
//
// token（id_token / access_token / refresh_token / OPENAI_API_KEY）只存在 vault 檔與 live auth.json，
// 不進任何 API 回應、log 或錯誤訊息。email / plan 只從 id_token 的 JWT payload（不驗簽）或 account/read 取。

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync,
  readdirSync, statSync, rmSync, mkdtempSync, realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { resolveBin, childEnv, expandHome } from './bin-resolve.js';
import {
  binVersion, maskEmail, sanitizeMessage, lastLine, killTree,
  toIso, round1, clampPct, httpError,
} from './accounts-common.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const VAULT_FILE_RE = /^([A-Za-z0-9_-]{1,80})\.json$/;
const BACKUP_RE = /^auth-[0-9TZ-]+\.json$/;

const PROBE_TIMEOUT_MS = 20_000;
const ACTIVE_TTL_MS = 60_000;
const OTHER_TTL_MS = 10 * 60_000;
const REFRESH_MIN_MS = 15_000;
const BACKUP_KEEP = 5;
const LABEL_MAX = 40;
const KILL_GRACE_MS = 2_000;
const MAX_STDOUT_LINE = 2 * 1024 * 1024;
const STDERR_KEEP = 8 * 1024;
const STALE_PROBE_DIR_MS = 10 * 60_000;
const STOP_WAIT_MS = 4_000;
const LIVE_REREAD_MS = 200;
const LIVE_KEY = '@live';

const AUTH_CLAIM = 'https://api.openai.com/auth';

// ───────── 小工具 ─────────

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function delay(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

// key 順序不同不算變更（codex 改寫 auth.json 時欄位順序可能和我們寫的不一樣）
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** auth.json → { id, email, plan, kind }（不含任何 token） */
export function authInfo(auth) {
  if (!isObj(auth)) return { id: null, email: null, plan: null, kind: null };
  const tokens = isObj(auth.tokens) ? auth.tokens : null;
  if (tokens) {
    const claims = decodeJwtPayload(tokens.id_token) ?? {};
    const authClaims = isObj(claims[AUTH_CLAIM]) ? claims[AUTH_CLAIM] : {};
    const rawId = str(tokens.account_id) ?? str(authClaims.chatgpt_account_id);
    return {
      id: rawId && ID_RE.test(rawId) ? rawId : null,
      email: str(claims.email),
      plan: str(authClaims.chatgpt_plan_type),
      kind: 'chatgpt',
    };
  }
  const key = str(auth.OPENAI_API_KEY);
  if (key) {
    return {
      id: `apikey-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
      email: null,
      plan: null,
      kind: 'apikey',
    };
  }
  return { id: null, email: null, plan: null, kind: null };
}

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// config.toml 頂層的 cli_auth_credentials_store（file / keyring / auto）；遇到第一個 [table] 就停
function readStoreMode(home) {
  let text;
  try { text = readFileSync(join(home, 'config.toml'), 'utf8'); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = /^cli_auth_credentials_store\s*=\s*["']([A-Za-z]+)["']/.exec(line);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** 使用者自訂名稱：trim、去控制字元、最多 40 字；空字串 → null */
export function parseLabel(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw httpError(400, '名稱必須是文字');
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, LABEL_MAX).join('').trim();
}

export function parseId(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw httpError(400, '帳號 id 格式不正確');
  return v;
}

// ───────── rate limits 正規化 ─────────

function windowLabel(mins, key) {
  if (mins === 10080) return { label: '1w', kind: 'weekly' };
  if (mins === 300) return { label: '5h', kind: 'session' };
  if (mins === null || mins <= 0) return { label: key === 'primary' ? '主要' : '次要', kind: 'other' };
  if (mins % 1440 === 0) return { label: `${mins / 1440}d`, kind: 'other' };
  if (mins % 60 === 0) return { label: `${mins / 60}h`, kind: 'other' };
  return { label: `${mins}m`, kind: 'other' };
}

function normRateWindow(w, key, now) {
  if (!isObj(w)) return null;
  const used = num(w.usedPercent);
  if (used === null) return null;
  const mins = num(w.windowDurationMins);
  const r = num(w.resetsAt);
  // 文件是 unix 秒；保險起見也吃毫秒 / ISO
  // 超出 Date 範圍的怪值（toISOString 會 throw RangeError）當成沒有重置時間，不讓整包用量失敗
  const ms = r !== null ? (r > 1e12 ? r : r * 1000) : NaN;
  const resetsAt = r !== null
    ? (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null)
    : toIso(w.resetsAt);
  const passed = resetsAt !== null && Date.parse(resetsAt) <= now;
  const u = passed ? 0 : round1(clampPct(used));
  const { label, kind } = windowLabel(mins, key);
  return {
    key,
    label,
    kind,
    window_minutes: mins,
    used_pct: u,
    remaining_pct: round1(100 - u),
    resets_at: resetsAt,
    reset_passed: passed,
  };
}

export function normRateWindows(rate, now = Date.now()) {
  if (!isObj(rate)) return [];
  const out = [normRateWindow(rate.primary, 'primary', now), normRateWindow(rate.secondary, 'secondary', now)]
    .filter(Boolean);
  // weekly 優先，其次視窗長的在前
  out.sort((a, b) => {
    if ((a.kind === 'weekly') !== (b.kind === 'weekly')) return a.kind === 'weekly' ? -1 : 1;
    return (b.window_minutes ?? -1) - (a.window_minutes ?? -1);
  });
  return out;
}

// app-server 的回應只留需要的欄位（credits 清單、upsell 之類不存）
function pickRate(result) {
  const rl = isObj(result?.rateLimits) ? result.rateLimits : null;
  if (!rl) return null;
  const credits = isObj(rl.credits) ? rl.credits : null;
  return {
    primary: isObj(rl.primary) ? rl.primary : null,
    secondary: isObj(rl.secondary) ? rl.secondary : null,
    credits: credits
      ? {
        has_credits: credits.hasCredits === true,
        unlimited: credits.unlimited === true,
        balance: credits.balance === null || credits.balance === undefined ? null : String(credits.balance),
      }
      : null,
    planType: str(rl.planType),
    rateLimitReachedType: str(rl.rateLimitReachedType),
    resetCreditsAvailable: num(result?.rateLimitResetCredits?.availableCount),
    accountId: str(result?.accountId),
  };
}

// ───────── service ─────────

export class CodexAccounts {
  constructor({ env = process.env, now = () => Date.now(), probeTimeoutMs = PROBE_TIMEOUT_MS, waitMs = PROBE_TIMEOUT_MS } = {}) {
    this.now = now;
    this.probeTimeoutMs = probeTimeoutMs;
    this.waitMs = waitMs;
    this.codexHome = env.CODEX_HOME ? resolve(expandHome(env.CODEX_HOME)) : join(homedir(), '.codex');
    // .env / launchd 不會展開 ~：子行程也要拿展開後的路徑，codex 讀的 auth.json 才會和我們讀寫的是同一份
    // （codex 不展開 ~，會直接拒絕啟動）。沒設 CODEX_HOME 就不補，讓 codex 用它自己的預設
    this.env = env.CODEX_HOME ? { ...env, CODEX_HOME: this.codexHome } : env;
    this.vaultDir = env.CODD_CODEX_VAULT ? resolve(expandHome(env.CODD_CODEX_VAULT)) : join(homedir(), '.fancy-codd', 'codex-accounts');
    this.backupDir = join(this.vaultDir, '.backup');
    this.probeRoot = join(this.vaultDir, '.probe');

    this._usage = new Map();       // account id → { at, okAt, ok, error, account, rate }
    this._liveProbe = null;        // keyring 模式下最後一次探測 live 的結果 { at, id, email, type, loggedOut, error }
    this._pending = new Map();     // key → 排隊中 / 執行中的探測 promise（同一帳號不重複排）
    this._hi = [];                 // 切換 / 存檔等使用者操作：插隊
    this._lo = [];                 // 探測
    this._running = false;
    this._current = null;          // 執行中的 job promise（stop 時等它收尾）
    this._child = null;            // 執行中的 codex app-server
    this._lastRefreshAll = 0;
    this._stopped = false;
    this._staleCleaned = false;
    this._lastLoggedError = '';
  }

  // ── 序列化 ──

  _enqueue(fn, { priority = false } = {}) {
    if (this._stopped) return Promise.reject(httpError(503, 'server 正在關閉'));
    return new Promise((resolveJob, rejectJob) => {
      (priority ? this._hi : this._lo).push({ fn, resolve: resolveJob, reject: rejectJob });
      this._drain();
    });
  }

  async _drain() {
    if (this._running) return;
    this._running = true;
    while (!this._stopped && (this._hi.length || this._lo.length)) {
      const job = this._hi.length ? this._hi.shift() : this._lo.shift();
      const run = (async () => job.fn())();
      this._current = run.catch(() => {});
      try { job.resolve(await run); } catch (e) { job.reject(e); }
      this._current = null;
    }
    this._running = false;
  }

  _scheduleProbe(key) {
    const existing = this._pending.get(key);
    if (existing) return existing;
    const p = this._enqueue(() => this._probeJob(key))
      .catch(() => {})
      .finally(() => { this._pending.delete(key); });
    this._pending.set(key, p);
    return p;
  }

  // ── 檔案 ──

  _liveAuthPath() {
    return join(this.codexHome, 'auth.json');
  }

  _readLive() {
    const file = this._liveAuthPath();
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { exists: false, text: null, data: null, info: authInfo(null), error: null };
      return { exists: true, text: null, data: null, info: authInfo(null), error: '無法讀取 Codex 的 auth.json' };
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* 下面處理 */ }
    if (!isObj(data)) {
      return { exists: true, text, data: null, info: authInfo(null), error: 'Codex 的 auth.json 不是合法的 JSON' };
    }
    return { exists: true, text, data, info: authInfo(data), error: null };
  }

  _storeMode() {
    return readStoreMode(this.codexHome);
  }

  // keyring 模式：憑證不在 auth.json，寫檔切換沒有用
  _isKeyring(live, mode = this._storeMode()) {
    return mode === 'keyring' || (mode === 'auto' && !live.exists);
  }

  _vaultPath(id) {
    return join(this.vaultDir, `${id}.json`);
  }

  _readVaultEntry(id) {
    if (!ID_RE.test(id)) return null;
    let data;
    try { data = JSON.parse(readFileSync(this._vaultPath(id), 'utf8')); } catch { return null; }
    if (!isObj(data) || data.id !== id || !isObj(data.auth)) return null;
    return data;
  }

  _listVault() {
    let names;
    try { names = readdirSync(this.vaultDir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = VAULT_FILE_RE.exec(name);
      if (!m) continue;
      const entry = this._readVaultEntry(m[1]);
      if (entry) out.push(entry);
    }
    return out;
  }

  _writeVaultEntry(entry) {
    if (!ID_RE.test(entry.id)) throw httpError(400, '帳號 id 格式不正確');
    ensureDir(this.vaultDir);
    const data = {
      id: entry.id,
      label: entry.label ?? null,
      email: entry.email ?? null,
      plan: entry.plan ?? null,
      saved_at: entry.saved_at ?? new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
      auth: entry.auth,
    };
    writeFileAtomic(this._vaultPath(entry.id), `${JSON.stringify(data, null, 2)}\n`, 0o600);
    return data;
  }

  // 把某份 auth 存進 vault（保留既有 label / saved_at）
  _upsertVault(auth, extra = {}) {
    const info = authInfo(auth);
    if (!info.id) throw httpError(422, '無法從憑證辨識 Codex 帳號');
    const existing = this._readVaultEntry(info.id);
    const probed = this._usage.get(info.id)?.account;
    return this._writeVaultEntry({
      id: info.id,
      label: extra.label !== undefined ? extra.label : existing?.label ?? null,
      email: str(probed?.email) ?? info.email ?? existing?.email ?? null,
      plan: info.plan ?? str(probed?.planType) ?? existing?.plan ?? null,
      saved_at: existing?.saved_at,
      auth,
    });
  }

  // live auth.json 被 codex 刷新過 → vault 裡有同一帳號就跟上（token 會輪替）
  _syncLiveToVault() {
    const live = this._readLive();
    if (!live.data || !live.info.id) return false;
    const entry = this._readVaultEntry(live.info.id);
    if (!entry || sameJson(entry.auth, live.data)) return false;
    this._writeVaultEntry({ ...entry, email: live.info.email ?? entry.email, plan: live.info.plan ?? entry.plan, auth: live.data });
    return true;
  }

  _backupLive(text) {
    ensureDir(this.backupDir);
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    let file = join(this.backupDir, `auth-${stamp}.json`);
    for (let i = 2; i < 100; i++) {
      try { statSync(file); } catch { break; }
      file = join(this.backupDir, `auth-${stamp}-${i}.json`);
    }
    writeFileAtomic(file, text, 0o600);
    this._pruneBackups();
    return file;
  }

  _pruneBackups() {
    let names;
    try { names = readdirSync(this.backupDir).filter(n => BACKUP_RE.test(n)); } catch { return; }
    const withTime = names.map((n) => {
      let t = 0;
      try { t = statSync(join(this.backupDir, n)).mtimeMs; } catch { /* ignore */ }
      return { n, t };
    });
    // 新的在前：mtime，同 mtime 再比檔名（檔名就是時間戳）
    withTime.sort((a, b) => (b.t - a.t) || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
    for (const { n } of withTime.slice(BACKUP_KEEP)) {
      try { unlinkSync(join(this.backupDir, n)); } catch { /* ignore */ }
    }
  }

  // 上次 server 當掉留下的暫存 CODEX_HOME（裡面有 token）；只清超過 10 分鐘的，避免誤刪另一個 server 正在用的
  _cleanupStaleProbeDirs() {
    if (this._staleCleaned) return;
    this._staleCleaned = true;
    let names;
    try { names = readdirSync(this.probeRoot); } catch { return; }
    for (const name of names) {
      if (!name.startsWith('p-')) continue;
      const dir = join(this.probeRoot, name);
      try {
        const st = statSync(dir);
        if (st.isDirectory() && this.now() - st.mtimeMs > STALE_PROBE_DIR_MS) rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  // ── 探測 ──

  _logOnce(msg) {
    if (msg === this._lastLoggedError) return;
    this._lastLoggedError = msg;
    console.warn('[codex-accounts]', msg);
  }

  /**
   * 跑一次 codex app-server。永不 reject；child 確實結束後才 resolve（暫存目錄要等它放手才能刪）。
   *   → { ok, error, account, rate, routedId, loggedOut }
   */
  _probe(binPath, home) {
    return new Promise((done) => {
      const env = childEnv(binPath, home ? { CODEX_HOME: home } : {}, this.env);
      let child;
      try {
        child = spawn(binPath, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
      } catch (e) {
        done({ ok: false, error: `無法執行 codex：${sanitizeMessage(e.code || e.message, 80)}`, account: null, rate: null });
        return;
      }
      this._child = child;
      let outcome = null;
      let buf = '';
      let stderr = '';
      let accountResp = null;
      let rateResp = null;
      let killTimer = null;
      let resolved = false;

      const settle = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (this._child === child) this._child = null;
        done(outcome ?? { ok: false, error: 'codex app-server 沒有回應', account: null, rate: null });
      };
      const finish = (result) => {
        if (!outcome) outcome = result;
        try { child.stdin.end(); } catch { /* ignore */ }
        killTree(child, 'SIGTERM');
        if (!killTimer) {
          killTimer = setTimeout(() => {
            killTree(child, 'SIGKILL');
            // SIGKILL 之後還是沒有 close（極少見）也不能讓探測卡住序列
            const t = setTimeout(settle, 1_000);
            t.unref?.();
          }, KILL_GRACE_MS);
          killTimer.unref?.();
        }
      };
      const send = (msg) => {
        try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* close 會處理 */ }
      };
      const rpcError = (resp) => sanitizeMessage(resp?.error?.message ?? JSON.stringify(resp?.error ?? ''), 140);

      const evaluate = () => {
        if (!accountResp || !rateResp) return;
        const account = isObj(accountResp.result?.account) ? accountResp.result.account : null;
        const routedId = str(accountResp.result?.workspaceRouting?.chatgptAccountId);
        const rate = rateResp.result ? pickRate(rateResp.result) : null;
        const acct = account ? { type: str(account.type), email: str(account.email), planType: str(account.planType) } : null;
        if (accountResp.error) {
          finish({ ok: false, error: `Codex 帳號讀取失敗：${rpcError(accountResp)}`, account: null, rate: null, routedId });
        } else if (!acct) {
          // 確定沒登入（不是逾時 / 崩潰這種暫時性失敗）：keyring 模式下要清掉上次認定的目前帳號
          finish({ ok: false, error: '沒有登入 Codex（憑證失效或已登出）', account: null, rate: null, routedId, loggedOut: true });
        } else if (rateResp.error || !rate) {
          finish({ ok: false, error: `Codex 用量讀取失敗：${rateResp.error ? rpcError(rateResp) : '回應格式不符'}`, account: acct, rate: null, routedId });
        } else {
          finish({ ok: true, error: null, account: acct, rate, routedId: rate.accountId ?? routedId });
        }
      };

      const onLine = (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        // 通知（沒有 id）與 server→client request（有 method）都略過
        if (!isObj(msg) || msg.id === undefined || msg.id === null || msg.method !== undefined) return;
        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, error: `Codex 初始化失敗：${rpcError(msg)}`, account: null, rate: null });
            return;
          }
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: {} });
          send({ id: 3, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          accountResp = msg;
          evaluate();
        } else if (msg.id === 3) {
          rateResp = msg;
          evaluate();
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (outcome) return;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(line);
          if (outcome) return;
        }
        if (buf.length > MAX_STDOUT_LINE) finish({ ok: false, error: 'codex app-server 輸出異常（單行過長）', account: null, rate: null });
      });
      // stderr 只留尾巴；啟動時的 config 警告不是錯誤，只有提前結束時才拿最後一行當說明
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_KEEP);
      });
      child.stdin.on('error', () => { /* EPIPE：close 會處理 */ });
      child.on('error', (e) => {
        if (!outcome) outcome = { ok: false, error: `無法執行 codex：${sanitizeMessage(e.code || e.message, 80)}`, account: null, rate: null };
        if (!child.pid) settle();
      });
      child.on('close', (code, signal) => {
        if (!outcome) {
          const tail = sanitizeMessage(lastLine(stderr), 140);
          outcome = {
            ok: false,
            error: `codex app-server 提前結束（${code ?? signal}）${tail ? `：${tail}` : ''}`,
            account: null,
            rate: null,
          };
        }
        settle();
      });

      const timer = setTimeout(() => {
        finish({ ok: false, error: `Codex 回應逾時（${Math.round(this.probeTimeoutMs / 1000)} 秒）`, account: null, rate: null });
      }, this.probeTimeoutMs);
      timer.unref?.();

      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fancy-codd', version: '0.1.0' } } });
    });
  }

  _record(id, r) {
    // 關機時被我們自己 kill 掉的探測不算失敗
    if (this._stopped) return;
    const prev = this._usage.get(id);
    const at = this.now();
    if (r.ok) {
      this._usage.set(id, { at, okAt: at, ok: true, error: null, account: r.account, rate: r.rate });
    } else {
      // 失敗時保留上一份成功的用量（usage_fetched_at 仍是那一次），讓前端還有東西可看
      this._usage.set(id, {
        at,
        okAt: prev?.okAt ?? null,
        ok: false,
        error: r.error,
        account: r.account ?? prev?.account ?? null,
        rate: prev?.rate ?? null,
      });
      this._logOnce(`探測 Codex 帳號 ${id} 失敗：${r.error}`);
    }
  }

  async _probeJob(key) {
    if (this._stopped) return;
    const bin = resolveBin('codex', this.env);
    if (!bin.path) return;
    // 排隊期間可能切換過帳號：「是不是目前帳號」在真正執行時才判斷
    let live = this._readLive();
    if (live.exists && !live.info.id) {
      // codex 刷新 token 時是原地截斷再寫入 auth.json：剛好讀到空檔 / 寫一半，稍候重讀一次
      await delay(LIVE_REREAD_MS);
      if (this._stopped) return;
      live = this._readLive();
    }
    const keyring = this._isKeyring(live);
    const activeId = this._activeId(live, keyring);

    // 目前帳號（或 keyring 模式下還不知道是誰的 live）：用真正的 CODEX_HOME，絕不用 vault 副本
    if (key === LIVE_KEY || (activeId && activeId === key)) {
      const r = await this._probe(bin.path, null);
      const after = this._readLive();
      const routed = r.routedId && ID_RE.test(r.routedId) ? r.routedId : null;
      // 逾時 / 崩潰 / 初始化失敗時 app-server 沒說是哪個帳號：沿用探測前認定的目前帳號
      // （保留上一次的用量、標成 error，帳號列不會整列消失）；確定登出就不沿用
      const transient = !r.account && !r.loggedOut;
      const id = after.info.id ?? routed ?? (transient && key !== LIVE_KEY ? key : null);
      if (id) this._record(id, r);
      if (!after.data) {
        const prev = transient ? this._liveProbe : null;
        this._liveProbe = {
          at: this.now(),
          id,
          // keyring 模式靠這兩個判斷 vault 裡哪幾筆可能是目前帳號（見 _maybeKeyringLive）
          email: r.account ? str(r.account.email) : prev?.email ?? null,
          type: r.account ? str(r.account.type) : prev?.type ?? null,
          loggedOut: r.loggedOut === true,
          error: r.ok ? null : r.error,
        };
      }
      try { this._syncLiveToVault(); } catch (e) { this._logOnce(`同步 live auth.json 回帳號庫失敗：${sanitizeMessage(e.code || e.message, 80)}`); }
      return;
    }

    // 認不出目前帳號（live auth.json 讀不到或壞掉）時不碰任何 vault 副本：
    // 它可能就是目前帳號，副本的 refresh token 可能早已被輪替掉
    if (live.exists && !live.info.id) return;

    // 其他帳號：暫存 CODEX_HOME + vault 副本
    const entry = this._readVaultEntry(key);
    if (!entry) return;
    if (keyring && !live.exists && this._maybeKeyringLive(entry)) {
      // 還不知道 keyring 裡是誰：這一輪先跳過（下次 GET 會先探測 live）；
      // 對得上 keyring 裡的帳號：標成 error 說明原因，免得一直顯示「探測中」
      const lp = this._liveProbe;
      if (lp?.id || lp?.email) {
        this._record(key, { ok: false, error: '可能是 keyring 裡的目前帳號，為避免用到舊憑證不探測', account: null, rate: null });
      }
      return;
    }
    ensureDir(this.vaultDir);
    ensureDir(this.probeRoot);
    this._cleanupStaleProbeDirs();
    const home = mkdtempSync(join(this.probeRoot, 'p-'));
    try {
      chmodSync(home, 0o700);
      // 強制用檔案存憑證：auto / keyring 會去碰系統 keychain
      writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      writeFileSync(join(home, 'auth.json'), `${JSON.stringify(entry.auth, null, 2)}\n`, { mode: 0o600 });
      const r = await this._probe(bin.path, home);
      this._record(key, r);
      // codex 刷新了 token → 原子寫回 vault（帳號對得上才寫）
      let refreshed = null;
      try { refreshed = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')); } catch { /* 被刪或壞掉就不寫回 */ }
      if (isObj(refreshed) && authInfo(refreshed).id === key && !sameJson(refreshed, entry.auth)) {
        const current = this._readVaultEntry(key);
        if (current) {
          const info = authInfo(refreshed);
          this._writeVaultEntry({ ...current, email: info.email ?? current.email, plan: info.plan ?? current.plan, auth: refreshed });
        }
      }
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch (e) {
        this._logOnce(`暫存 CODEX_HOME 清理失敗：${sanitizeMessage(e.code || e.message, 80)}`);
      }
    }
  }

  // keyring 模式：目前帳號的憑證不在檔案裡，只能靠探測 live 拿到的 account id / email 判斷 vault 裡哪一筆是它。
  // 還不知道（live 還沒探測出來）或對得上的都當成「可能是目前帳號」，不能用 vault 副本探測。
  // 一個 email 可能有好幾個 workspace（account id 不同），同 email 的一律跳過：寧可少探測，也不要拿舊 refresh token 去刷新
  _maybeKeyringLive(entry) {
    const lp = this._liveProbe;
    if (lp?.loggedOut) return false;
    // API key 等非 ChatGPT 登入沒有會輪替的 refresh token，vault 副本不會跟它搶
    if (lp?.type && lp.type !== 'chatgpt') return false;
    if (!lp?.id && !lp?.email) return true;
    if (lp.id && lp.id === entry.id) return true;
    if (!lp.email) return false;
    const want = lp.email.toLowerCase();
    return [entry.email, authInfo(entry.auth).email].some(e => str(e)?.toLowerCase() === want);
  }

  // ── payload ──

  _activeId(live, keyring) {
    if (live.info.id) return live.info.id;
    if (keyring && !live.exists) return this._liveProbe?.id ?? null;
    return null;
  }

  _buildPayload(bin, version) {
    const now = this.now();
    const live = this._readLive();
    const mode = this._storeMode();
    const keyring = this._isKeyring(live, mode);
    const activeId = this._activeId(live, keyring);
    const vault = this._listVault();

    let error = null;
    if (!bin.path) {
      error = bin.source === 'env' ? `${bin.envVar} 指到的 codex 不存在或不能執行` : '找不到 codex 執行檔';
    } else if (keyring) {
      error = 'Codex 憑證存在 keyring，無法切換';
      // 認不出目前帳號（沒登入、探測失敗）時把真正的原因帶上，不然前端只看得到「未登入」
      if (!live.exists && !activeId && this._liveProbe?.error) error = `${this._liveProbe.error}；${error}`;
    } else if (live.error) {
      error = live.error;
    }

    const rows = new Map();
    for (const v of vault) {
      rows.set(v.id, { id: v.id, label: str(v.label), email: str(v.email), plan: str(v.plan), saved: true, savedAt: v.saved_at ?? '' });
    }
    if (activeId && !rows.has(activeId)) {
      rows.set(activeId, { id: activeId, label: null, email: live.info.email, plan: live.info.plan, saved: false, savedAt: '' });
    }

    let latest = 0;
    const accounts = [...rows.values()].map((row) => {
      const u = this._usage.get(row.id);
      if (u?.at > latest) latest = u.at;
      const active = row.id === activeId;
      const email = str(u?.account?.email) ?? row.email ?? (active ? live.info.email : null);
      let status = 'pending';
      let rowError = null;
      if (!bin.path) {
        status = 'error';
        rowError = '找不到 codex 執行檔';
      } else if (u) {
        status = u.ok ? 'ok' : 'error';
        rowError = u.ok ? null : u.error;
      }
      return {
        id: row.id,
        label: row.label,
        email,
        email_masked: maskEmail(email),
        plan: u?.rate?.planType ?? str(u?.account?.planType) ?? row.plan ?? (active ? live.info.plan : null),
        active,
        saved: row.saved,
        status,
        error: rowError,
        usage_fetched_at: u?.okAt ? new Date(u.okAt).toISOString() : null,
        usage_age_seconds: u?.okAt ? round1(Math.max(0, (now - u.okAt) / 1000)) : null,
        windows: normRateWindows(u?.rate, now),
        credits: u?.rate?.credits ?? null,
        reset_credits_available: u?.rate?.resetCreditsAvailable ?? null,
        limit_reached: u?.rate?.rateLimitReachedType ?? null,
        _savedAt: row.savedAt,
      };
    });
    accounts.sort((a, b) => (Number(b.active) - Number(a.active))
      || (Number(b.saved) - Number(a.saved))
      || String(a._savedAt).localeCompare(String(b._savedAt))
      || a.id.localeCompare(b.id));
    for (const a of accounts) delete a._savedAt;

    return {
      available: !!bin.path,
      error,
      version,
      can_switch: !keyring && !live.error && (!live.exists || !!live.info.id),
      active_id: activeId,
      fetched_at: new Date(latest || now).toISOString(),
      accounts,
    };
  }

  /** GET /api/accounts/codex 的 payload。有快取先回快取（背景更新）；冷啟動等目前帳號探測完（最多 20 s） */
  async get({ refresh = false } = {}) {
    const bin = resolveBin('codex', this.env);
    const env = bin.path ? childEnv(bin.path, {}, this.env) : null;
    const versionP = bin.path ? binVersion(bin.path, env) : Promise.resolve(null);

    if (bin.path && !this._stopped) {
      const now = this.now();
      const force = refresh && now - this._lastRefreshAll >= REFRESH_MIN_MS;
      if (force) this._lastRefreshAll = now;
      const live = this._readLive();
      const keyring = this._isKeyring(live);
      const activeId = this._activeId(live, keyring);
      // 目前帳號排最前面：冷啟動時要等的是它，不要排在其他帳號後面
      const keys = new Set(activeId ? [activeId] : []);
      // live auth.json 讀不到 / 壞掉（codex 可能正在改寫）：認不出目前帳號，這一輪不排任何 vault 探測
      if (!(live.exists && !live.info.id)) for (const v of this._listVault()) keys.add(v.id);

      const waits = [];
      const consider = (key, isActive, have) => {
        const ttl = isActive ? ACTIVE_TTL_MS : OTHER_TTL_MS;
        const stale = !have || now - have.at >= ttl;
        if (!force && !stale) return;
        const p = this._scheduleProbe(key);
        // refresh：全部等（有上限）；平常：只有目前帳號完全沒資料時才等
        if (force || (isActive && !have)) waits.push(p);
      };
      // keyring 模式且還不知道目前是哪個帳號：先探測 live，排在所有 vault 帳號前面
      // （要先知道 keyring 裡是誰，才知道哪一筆不能用 vault 副本探測）
      if (keyring && !live.exists && !activeId) consider(LIVE_KEY, true, this._liveProbe);
      for (const id of keys) consider(id, id === activeId, this._usage.get(id));

      if (waits.length) await Promise.race([Promise.allSettled(waits), delay(this.waitMs)]);
    }
    return this._buildPayload(bin, await versionP);
  }

  // ── 使用者操作（都插隊進序列，做完才組 payload，避免在序列裡等探測而卡死）──

  async saveCurrent(labelInput) {
    const label = labelInput === undefined ? undefined : parseLabel(labelInput);
    await this._enqueue(() => {
      const live = this._readLive();
      const mode = this._storeMode();
      if (mode === 'keyring' || (mode === 'auto' && !live.exists)) throw httpError(409, 'Codex 憑證存在 keyring，無法加入帳號庫');
      if (live.error) throw httpError(409, live.error);
      if (!live.exists) throw httpError(409, '目前沒有登入 Codex，請先在主機上執行 codex login');
      if (!live.info.id) throw httpError(422, '無法從 auth.json 辨識 Codex 帳號');
      this._upsertVault(live.data, { label });
    }, { priority: true });
    return this.get();
  }

  async switchTo(idInput) {
    const id = parseId(idInput);
    const switched = await this._enqueue(() => this._switchJob(id), { priority: true });
    const payload = await this.get();
    return { ok: true, switched, ...payload };
  }

  _switchJob(id) {
    const target = this._readVaultEntry(id);
    if (!target) throw httpError(404, '帳號庫裡找不到這個帳號');
    if (authInfo(target.auth).id !== id) throw httpError(422, '帳號庫裡的憑證和帳號對不上，請移除後重新加入');
    const live = this._readLive();
    if (this._isKeyring(live)) throw httpError(409, 'Codex 憑證存在 keyring，無法切換');
    if (live.error) throw httpError(409, `${live.error}，為避免遺失憑證先不切換`);
    const from = live.info.id;
    if (from === id) return null;

    if (live.exists) {
      if (!from) throw httpError(409, '無法辨識目前登入的 Codex 帳號，為避免遺失憑證先不切換');
      // 1. 目前帳號存回 vault（就算之前沒存過也存，切走之後憑證才不會遺失）
      this._upsertVault(live.data);
      // 2. 原檔備份
      this._backupLive(live.text);
    }

    // 3. 原子寫入 live auth.json（symlink 就寫到它指向的檔）
    let file = this._liveAuthPath();
    if (live.exists) {
      try { file = realpathSync(file); } catch { /* 用原路徑 */ }
    } else {
      ensureDir(this.codexHome);
    }
    writeFileAtomic(file, `${JSON.stringify(target.auth, null, 2)}\n`, 0o600);

    // 4. 新的目前帳號下次 GET 一定重探（用 live）；舊帳號的用量資料仍有效，留著
    const u = this._usage.get(id);
    if (u) this._usage.set(id, { ...u, at: 0 });
    this._liveProbe = null;
    return { from: from ?? null, to: id };
  }

  async rename(idInput, labelInput) {
    const id = parseId(idInput);
    if (labelInput === undefined) throw httpError(400, '缺少 label');
    const label = parseLabel(labelInput);
    await this._enqueue(() => {
      const entry = this._readVaultEntry(id);
      if (!entry) throw httpError(404, '帳號庫裡找不到這個帳號');
      this._writeVaultEntry({ ...entry, label });
    }, { priority: true });
    return this.get();
  }

  async remove(idInput) {
    const id = parseId(idInput);
    await this._enqueue(() => {
      const file = this._vaultPath(id);
      try {
        unlinkSync(file);
      } catch (e) {
        if (e.code === 'ENOENT') throw httpError(404, '帳號庫裡找不到這個帳號');
        throw e;
      }
      // 目前帳號被刪只是變回 saved:false，用量留著
      if (this._readLive().info.id !== id) this._usage.delete(id);
    }, { priority: true });
    return this.get();
  }

  /** graceful shutdown：丟掉排隊中的工作、收掉執行中的 app-server，等暫存目錄清完（最多 4 s） */
  async stop() {
    this._stopped = true;
    const queued = [...this._hi, ...this._lo];
    this._hi = [];
    this._lo = [];
    for (const job of queued) job.reject(httpError(503, 'server 正在關閉'));
    if (this._child) {
      const child = this._child;
      try { child.stdin.end(); } catch { /* ignore */ }
      killTree(child, 'SIGTERM');
      const t = setTimeout(() => killTree(child, 'SIGKILL'), 1_500);
      t.unref?.();
    }
    if (this._current) await Promise.race([this._current, delay(STOP_WAIT_MS)]);
  }
}
