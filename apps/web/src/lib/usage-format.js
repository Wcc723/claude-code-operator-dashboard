// 側欄底部「主機 + 用量」共用的格式化：DeviceStatus（HOST）、UsagePanel、AccountsPopover 都用這一份。
// 純函式、不 import Vue：node 直接 import 就能測。
// 現在時間一律由呼叫端傳進來（元件自己的 30 秒 ticker），不在這裡讀 Date.now()，倒數才會跟畫面一起走。

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const weekdayFmt = new Intl.DateTimeFormat('zh-TW', { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

// 用量資料超過 30 分鐘沒更新就變灰（statusline 與 cswap 都一樣）
export const USAGE_STALE_SEC = 1800;

export function num(n) { return Number.isFinite(n) ? n : null; }
export function clamp(n) { return Math.max(0, Math.min(100, n)); }
export function pad2(n) { return String(n).padStart(2, '0'); }
export function fmt0(n) { return nf0.format(n); }
export function fmt1(n) { return nf1.format(n); }
export function pct(n) { return `${nf0.format(n)}%`; }
export function fullTime(ms) { return fullFmt.format(new Date(ms)); }

export function relTime(sec) {
  if (sec == null) return '';
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

export function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${pad2(m)}m`;
  return `${m}m`;
}

// 重置的時間點：今天只寫時間；明天寫「明天」；再更久寫日期 + 星期（1w 視窗最遠接近 7 天，光寫星期幾會跟今天撞名）
export function resetWhen(resetMs, nowMs) {
  const d = new Date(resetMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = d.toDateString();
  if (day === new Date(nowMs).toDateString()) return hm;
  if (day === new Date(nowMs + 86400000).toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${weekdayFmt.format(d)} ${hm}`;
}

export function resetIn(resetMs, nowMs) {
  return `${duration(Math.ceil(Math.max(0, resetMs - nowMs) / 60000) * 60)}後`;
}

// server 算 age 時的時間點 + 本機收到之後經過的秒數；不拿 server 給的 ISO 時間直接減，避開手機與主機的時鐘差
export function ageSeconds(baseAgeSec, receivedAtMs, nowMs) {
  const a = num(baseAgeSec);
  if (a == null) return null;
  const extra = receivedAtMs ? Math.max(0, (nowMs - receivedAtMs) / 1000) : 0;
  return a + extra;
}

export function isStale(ageSec, limitSec = USAGE_STALE_SEC) {
  return ageSec != null && ageSec > limitSec;
}

export function remainingTone(remaining) {
  if (remaining < 20) return 'crit';
  if (remaining < 50) return 'warn';
  return 'ok';
}

/**
 * 一個用量視窗 → 畫面要的欄位。吃兩種來源：
 *  - /api/accounts/*（cswap / codex）：used_pct、remaining_pct、expected_pct、ahead_of_pace、will_last…
 *  - /api/system 的 statusline 用量（沒有 cswap 時的退路）：used_percentage、remaining_percentage
 * w 是 null 表示「知道有這個視窗，但還沒收到資料」：照樣列出來，看得出只是在等回報。
 */
export function usageWindow(w, nowMs, { key, label } = {}) {
  const k = key ?? w?.key ?? label ?? '?';
  const name = label ?? w?.label ?? k;
  if (!w) {
    return {
      key: k,
      label: name,
      kind: null,
      passed: false,
      remaining: 0,
      tone: 'muted',
      pctTone: 'muted',
      pctText: '—',
      resetMs: null,
      resetText: '等待回報',
      resetIn: '',
      pace: null,
      ahead: false,
      paceText: '',
      title: `${name} 視窗還沒有資料：Claude Code 回報用量後才會出現（只有訂閱方案會回報）`,
    };
  }

  const parsed = w.resets_at ? Date.parse(w.resets_at) : NaN;
  const resetMs = Number.isFinite(parsed) ? parsed : null;
  // server 標了 reset_passed，或是重置時間在 server 回應之後才過（畫面放著沒重抓）
  const passed = Boolean(w.reset_passed) || (resetMs != null && resetMs <= nowMs);
  const usedRaw = num(w.used_pct) ?? num(w.used_percentage);
  const remRaw = num(w.remaining_pct) ?? num(w.remaining_percentage);
  const used = passed ? 0 : clamp(usedRaw ?? (remRaw != null ? 100 - remRaw : 0));
  const remaining = passed ? 100 : clamp(remRaw ?? 100 - used);
  const tone = passed ? 'muted' : remainingTone(remaining);

  // 照進度應該剩多少：expected_pct 是「照目前經過的時間應該用掉多少 %」，刻度畫在剩餘 = 100 - expected 的位置
  const expected = passed ? null : num(w.expected_pct);
  const pace = expected == null ? null : clamp(100 - expected);
  const ahead = !passed && w.ahead_of_pace === true;
  // 已經是 warn / crit 就維持原本的顏色，只有 ok 時才因為「超前用量」改成 warn
  const pctTone = ahead && tone === 'ok' ? 'warn' : tone;

  const exhaustMs = w.projected_exhaustion_at ? Date.parse(w.projected_exhaustion_at) : NaN;
  const notes = [];
  if (pace != null) notes.push(`照進度應該剩 ${fmt1(pace)}%${ahead ? '（用得比進度快）' : ''}`);
  if (!passed && w.will_last === false) {
    notes.push(Number.isFinite(exhaustMs) && exhaustMs > nowMs
      ? `照目前速度約 ${fullTime(exhaustMs)} 用完`
      : '照目前速度撐不到重置');
  }
  const paceText = notes.join('，');

  let title;
  if (passed) {
    title = `${name} 視窗已過重置時間，額度視為 100%（等下一次回報更新）`;
  } else {
    title = `${name} 視窗：已用 ${fmt1(used)}%，剩 ${fmt1(remaining)}%`
      + (resetMs != null ? `，${fullTime(resetMs)} 重置` : '')
      + (paceText ? `；${paceText}` : '');
  }

  return {
    key: k,
    label: name,
    kind: w.kind ?? null,
    passed,
    remaining,
    tone,
    pctTone,
    pctText: pct(remaining),
    resetMs,
    resetText: passed ? '已重置' : resetMs != null ? `重置 ${resetWhen(resetMs, nowMs)}` : '',
    resetIn: !passed && resetMs != null ? resetIn(resetMs, nowMs) : '',
    pace,
    ahead,
    paceText,
    title,
  };
}

/**
 * 精簡模式省空間：跟前面某一列重置時間差不到 toleranceMs 的列，不再重複一行重置時間
 * （例如 Fable 跟 1w 只差一分鐘重置）。完整時間仍在 title 裡。
 */
export function dedupeResets(rows, toleranceMs = 3600000) {
  const shown = [];
  return rows.map((r) => {
    if (r.resetMs == null || r.passed) return { ...r, hideReset: false };
    const dup = shown.some((ms) => Math.abs(ms - r.resetMs) < toleranceMs);
    if (!dup) shown.push(r.resetMs);
    return { ...r, hideReset: dup };
  });
}

/** Claude 的視窗：weekly + model scoped 畫 bar；5h（kind 'session'，Claude 已取消）另外回傳，只在展開清單用小字顯示 */
export function splitClaudeWindows(acct) {
  const all = Array.isArray(acct?.windows) ? acct.windows : [];
  return {
    main: all.filter((w) => w?.kind !== 'session'),
    session: all.filter((w) => w?.kind === 'session'),
  };
}

/** 帳號顯示名稱：alias（cswap）→ label（Codex 帳號庫）→ masked email；完整 email 只能放 title */
export function accountName(acct) {
  if (!acct) return '—';
  const pick = [acct.alias, acct.label, acct.email_masked]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .find(Boolean);
  if (pick) return pick;
  if (typeof acct.id === 'string' && acct.id.startsWith('apikey-')) return 'API key';
  if (Number.isFinite(acct.number)) return `#${acct.number}`;
  return '未命名帳號';
}

/** title 用：完整 email + 組織 / 方案（只放 title，不直接顯示） */
export function accountTitle(acct) {
  if (!acct) return '';
  return [acct.email, acct.organization, acct.plan].filter((s) => typeof s === 'string' && s).join(' · ');
}

export function activeAccount(payload) {
  const list = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return list.find((a) => a?.active)
    ?? (payload?.active_number != null ? list.find((a) => a?.number === payload.active_number) : null)
    ?? (payload?.active_id != null ? list.find((a) => a?.id === payload.active_id) : null)
    ?? null;
}

/**
 * Codex 區塊要不要整個藏起來：主機上根本沒有 codex 執行檔就不佔位置；
 * 其他 available:false（逾時、keyring 讀不到…）留一行灰字說原因。
 */
export function codexHidden(payload) {
  if (!payload || payload.available !== false) return false;
  const err = typeof payload.error === 'string' ? payload.error : '';
  return !err || /找不到|未安裝|not found|ENOENT/i.test(err);
}
