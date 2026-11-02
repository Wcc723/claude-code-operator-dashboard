// 側欄用量面板要顯示哪些列：只存在這台裝置（localStorage），手機跟電腦可以各自設定。
// 點帳號展開的浮層不受影響，一律列出全部。
// 存的是「藏起來的」：之後 cswap / Codex 多回一種視窗，預設照樣顯示，不會被默默藏掉。
import { ref } from 'vue';

const KEY = 'codd.usageHidden';
// 預設藏 Claude 的 Fable 視窗（側欄空間不夠，需要時點帳號展開看）
export const DEFAULT_HIDDEN = Object.freeze(['claude:model:fable']);

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return [...DEFAULT_HIDDEN];
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.length <= 120).slice(0, 50);
  } catch {}
  return [...DEFAULT_HIDDEN];
}

const hidden = ref(load());

// 另一個分頁改了設定，這裡跟著換
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) hidden.value = load();
  });
}

/**
 * 一列用量的設定 key（不分大小寫）。
 *  - Claude：視窗的 key（'7d'、'model:Fable'）；沒有 cswap 時 statusline 退路的 '1w' 跟 cswap 的 1w 是同一個
 *  - Codex：視窗的 label（'5h'、'1w'）：primary / secondary 對到哪個長度不固定，用長度認比較穩
 */
export function usagePrefKey(provider, w) {
  if (provider === 'claude') {
    const k = w?.key === '1w' ? '7d' : w?.key;
    return `claude:${String(k ?? '?')}`.toLowerCase();
  }
  return `${provider}:${String(w?.label ?? w?.key ?? '?')}`.toLowerCase();
}

export function isUsageShown(pk) {
  return !hidden.value.includes(pk);
}

export function setUsageShown(pk, on) {
  const next = hidden.value.filter((k) => k !== pk);
  if (!on) next.push(pk);
  hidden.value = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}
