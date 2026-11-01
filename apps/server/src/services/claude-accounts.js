// Claude 帳號清單與切換：包一層 claude-swap（cswap）CLI。
//
// cswap 自己管帳號 slot、憑證與用量快取；這裡只負責
//   1. 跑 `cswap list --json`，正規化成前端要的形狀（unclaimedCredentials、organizationUuid 不往外送）
//   2. 跑 `cswap switch <n> --json`
// 快取 20 s；同一時間只跑一個 list（single-flight），?refresh=1 在 5 s 內重複按也只回快取。
// 「已過重置時間」與 usage_age_seconds 依回應當下的時間換算，所以快取存的是 cswap 原始 JSON。

import { resolveBin, childEnv } from './bin-resolve.js';
import {
  runCommand, binVersion, maskEmail, sanitizeMessage, lastLine,
  toIso, round1, clampPct, killTree, httpError,
} from './accounts-common.js';

const LIST_TIMEOUT_MS = 15_000;
const SWITCH_TIMEOUT_MS = 30_000;
const CACHE_MS = 20_000;
const REFRESH_MIN_MS = 5_000;
const MAX_ACCOUNT_NUMBER = 9999;

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

function bool(v) {
  return typeof v === 'boolean' ? v : null;
}

// cswap 的一個 usage window → 契約的 window；pct 是「已用 %」
function normWindow(w, { key, label, kind }, now) {
  if (!isObj(w)) return null;
  const pct = num(w.pct);
  if (pct === null) return null;
  const resetsAt = toIso(w.resetsAt);
  const passed = resetsAt !== null && Date.parse(resetsAt) <= now;
  const used = passed ? 0 : round1(clampPct(pct));
  return {
    key,
    label,
    kind,
    used_pct: used,
    remaining_pct: round1(100 - used),
    resets_at: resetsAt,
    reset_passed: passed,
    // 視窗已重置時，舊的配速預估沒有意義
    expected_pct: passed ? null : num(w.expectedPct),
    ahead_of_pace: passed ? null : bool(w.aheadOfPace),
    will_last: passed ? null : bool(w.willLastToReset),
    projected_exhaustion_at: passed ? null : toIso(w.projectedExhaustionAt),
  };
}

function normWindows(usage, now) {
  if (!isObj(usage)) return [];
  const out = [];
  const weekly = normWindow(usage.sevenDay, { key: '7d', label: '1w', kind: 'weekly' }, now);
  if (weekly) out.push(weekly);
  const seen = new Set();
  for (const s of Array.isArray(usage.scoped) ? usage.scoped : []) {
    const name = str(s?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const w = normWindow(s, { key: `model:${name}`, label: name, kind: 'model' }, now);
    if (w) out.push(w);
  }
  // Claude 已取消 5 小時用量；cswap 對部分帳號仍會回，放最後讓前端自己決定要不要顯示
  const session = normWindow(usage.fiveHour, { key: '5h', label: '5h', kind: 'session' }, now);
  if (session) out.push(session);
  return out;
}

function usageAge(src, fetchedAtMs, now) {
  const at = Date.parse(src.fetchedAt);
  if (Number.isFinite(at)) return round1(Math.max(0, (now - at) / 1000));
  const age = num(src.ageSeconds);
  if (age !== null) return round1(age + Math.max(0, (now - fetchedAtMs) / 1000));
  return null;
}

export function normalizeClaudeList(raw, { fetchedAtMs, now = Date.now() } = {}) {
  const list = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const accounts = [];
  for (const acc of list) {
    if (!isObj(acc)) continue;
    const number = num(acc.number);
    if (number === null || !Number.isInteger(number)) continue;
    const email = str(acc.email);
    // usageStatus 不是 ok 時 cswap 給 usage:null，最後一次成功的用量另放在 lastGood*：拿來顯示，並標 usage_stale。
    // API key 帳號沒有訂閱額度，cswap 自己也不顯示它的 last-seen
    const stale = !isObj(acc.usage) && acc.usageStatus !== 'api_key' && isObj(acc.lastGoodUsage);
    const src = isObj(acc.usage)
      ? { usage: acc.usage, fetchedAt: acc.usageFetchedAt, ageSeconds: acc.usageAgeSeconds }
      : stale
        ? { usage: acc.lastGoodUsage, fetchedAt: acc.lastGoodFetchedAt, ageSeconds: acc.lastGoodAgeSeconds }
        : { usage: null, fetchedAt: null, ageSeconds: null };
    accounts.push({
      number,
      alias: str(acc.alias),
      email,
      email_masked: maskEmail(email),
      organization: str(acc.organizationName),
      active: acc.active === true,
      status: str(acc.usageStatus),
      usage_fetched_at: toIso(src.fetchedAt),
      usage_age_seconds: usageAge(src, fetchedAtMs, now),
      usage_stale: stale,
      windows: normWindows(src.usage, now),
    });
  }
  accounts.sort((a, b) => a.number - b.number);
  const declared = num(raw?.activeAccountNumber);
  const activeNumber = declared !== null && Number.isInteger(declared)
    ? declared
    : accounts.find(a => a.active)?.number ?? null;
  return { active_number: activeNumber, accounts };
}

// cswap --json 失敗時把錯誤包在 stdout 的 { error: { type, message } }；沒有就拿 stderr 最後一行
function cswapErrorText(r) {
  try {
    const v = JSON.parse(r.stdout);
    const msg = str(v?.error?.message);
    if (msg) return msg;
  } catch { /* 不是 JSON */ }
  return lastLine(r.stderr) || lastLine(r.stdout);
}

function parseNumber(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d{1,6}$/.test(v.trim())) return Number(v.trim());
  return null;
}

export class ClaudeAccounts {
  constructor({ env = process.env, now = () => Date.now(), listTimeoutMs = LIST_TIMEOUT_MS, switchTimeoutMs = SWITCH_TIMEOUT_MS } = {}) {
    this.env = env;
    this.now = now;
    this.listTimeoutMs = listTimeoutMs;
    this.switchTimeoutMs = switchTimeoutMs;
    this._cache = null;      // { at, available, error, version, raw }
    this._inflight = null;
    this._switching = false;
    this._children = new Set();
  }

  _bin() {
    return resolveBin('cswap', this.env);
  }

  async _fetch() {
    const startedAt = this.now();
    const bin = this._bin();
    if (!bin.path) {
      return {
        at: startedAt,
        available: false,
        error: bin.source === 'env'
          ? `${bin.envVar} 指到的 cswap 不存在或不能執行`
          : '找不到 cswap，安裝後即可切換帳號',
        version: null,
        raw: null,
      };
    }
    const env = childEnv(bin.path, {}, this.env);
    const [r, version] = await Promise.all([
      runCommand(bin.path, ['list', '--json'], { timeoutMs: this.listTimeoutMs, env, tracker: this._children }),
      binVersion(bin.path, env),
    ]);
    const base = { at: startedAt, version, raw: null };
    if (r.error) return { ...base, available: false, error: `無法執行 cswap：${sanitizeMessage(r.error.code || r.error.message, 80)}` };
    if (r.timedOut) return { ...base, available: false, error: `cswap 回應逾時（${Math.round(this.listTimeoutMs / 1000)} 秒）` };
    if (r.overflow) return { ...base, available: false, error: 'cswap 輸出過大，已中止' };
    if (r.code !== 0) {
      const detail = sanitizeMessage(cswapErrorText(r), 160);
      return { ...base, available: false, error: `cswap list 失敗${detail ? `：${detail}` : `（exit ${r.code ?? r.signal}）`}` };
    }
    let raw;
    try {
      raw = JSON.parse(r.stdout);
    } catch {
      return { ...base, available: false, error: 'cswap 輸出不是合法的 JSON（版本不相容？）' };
    }
    if (!isObj(raw) || !Array.isArray(raw.accounts)) {
      return { ...base, available: false, error: 'cswap 輸出格式不符（缺少 accounts）' };
    }
    // 只留需要的欄位：unclaimedCredentials 等不進快取，更不會送到前端
    return { ...base, available: true, error: null, raw: { activeAccountNumber: raw.activeAccountNumber, accounts: raw.accounts } };
  }

  // single-flight：同時多個請求共用同一次 cswap list
  _load() {
    if (!this._inflight) {
      this._inflight = this._fetch()
        .then((c) => { this._cache = c; return c; })
        .finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  _payload(c) {
    const now = this.now();
    const norm = c.available && c.raw
      ? normalizeClaudeList(c.raw, { fetchedAtMs: c.at, now })
      : { active_number: null, accounts: [] };
    return {
      available: c.available,
      error: c.error,
      version: c.version,
      active_number: norm.active_number,
      fetched_at: new Date(c.at).toISOString(),
      accounts: norm.accounts,
    };
  }

  /** GET /api/accounts/claude 的 payload；永不 throw（失敗 → available:false + error） */
  async get({ refresh = false } = {}) {
    const c = this._cache;
    const age = c ? this.now() - c.at : Infinity;
    let loaded;
    if (this._inflight) loaded = await this._inflight;
    else if (c && (refresh ? age < REFRESH_MIN_MS : age < CACHE_MS)) loaded = c;
    else loaded = await this._load();
    return this._payload(loaded);
  }

  /** 切換到 slot <number>；成功回 { ok, switched:{from,to}, ...payload }，失敗 throw（err.status） */
  async switch(input) {
    const number = parseNumber(input);
    if (number === null || number < 1 || number > MAX_ACCOUNT_NUMBER) {
      throw httpError(400, '帳號編號必須是正整數');
    }
    if (this._switching) throw httpError(409, '另一個切換正在進行中，請稍候');
    this._switching = true;
    try {
      // 用最新的清單驗證（正在跑的 list 就直接共用它的結果）
      const fresh = await this._load();
      if (!fresh.available) throw httpError(503, fresh.error || 'cswap 無法使用');
      const before = normalizeClaudeList(fresh.raw, { fetchedAtMs: fresh.at, now: this.now() });
      if (!before.accounts.some(a => a.number === number)) throw httpError(404, `找不到帳號 #${number}`);

      const bin = this._bin();
      if (!bin.path) throw httpError(503, '找不到 cswap，安裝後即可切換帳號');
      const env = childEnv(bin.path, {}, this.env);
      // 不進 tracker：server 關機時不中斷寫到一半的憑證切換（自己的 30 s 逾時仍然有效）
      const r = await runCommand(bin.path, ['switch', String(number), '--json'], {
        timeoutMs: this.switchTimeoutMs, env,
      });
      if (r.error) throw httpError(503, `無法執行 cswap：${sanitizeMessage(r.error.code || r.error.message, 80)}`);
      if (r.timedOut) {
        this._cache = null;
        throw httpError(502, `cswap 切換逾時（${Math.round(this.switchTimeoutMs / 1000)} 秒），帳號狀態不明，請重新整理確認`);
      }
      if (r.code !== 0) {
        // 失敗也可能切到一半：下一次 GET 重抓，不要拿切換前的快取
        this._cache = null;
        const detail = sanitizeMessage(cswapErrorText(r), 160);
        throw httpError(502, `cswap 切換失敗${detail ? `：${detail}` : `（exit ${r.code ?? r.signal}）`}`);
      }
      let result = null;
      try { result = JSON.parse(r.stdout); } catch { /* exit 0 就當成功，from/to 用我們知道的 */ }
      const from = parseNumber(result?.from?.number) ?? before.active_number ?? null;
      const to = parseNumber(result?.to?.number) ?? number;

      // 切換前就開始跑的 list 是舊狀態：等它結束後再重抓一次
      if (this._inflight) await this._inflight;
      this._cache = null;
      const payload = this._payload(await this._load());
      return { ok: true, switched: { from, to }, ...payload };
    } finally {
      this._switching = false;
    }
  }

  /** graceful shutdown：收掉進行中的 cswap list（切換不收，見 switch） */
  stop() {
    for (const child of this._children) killTree(child, 'SIGTERM');
  }
}
