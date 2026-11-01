// Session / Project 標記色的 key 白名單。前端 apps/web/src/colors.js 有同一份清單（含色碼）。
export const COLOR_KEYS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'];

const KEYS = new Set(COLOR_KEYS);

/**
 * 解析 request 帶來的顏色：
 * - null / '' / 'none' → null（清除顏色）
 * - 白名單內的 key → 原樣回傳
 * - 其他 → throw，err.status = 400
 */
export function parseColor(v) {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  if (typeof v === 'string' && KEYS.has(v)) return v;
  const err = new Error(`color must be one of: ${COLOR_KEYS.join(', ')} (or null)`);
  err.status = 400;
  throw err;
}

/** 讀 DB / 記憶體裡的值時用：不合法就當成沒有顏色，不 throw */
export function sanitizeColor(v) {
  return typeof v === 'string' && KEYS.has(v) ? v : null;
}
