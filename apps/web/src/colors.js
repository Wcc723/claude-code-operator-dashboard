// Session / Project 標記色。key 存在 server（session record 與 launch_profiles.color），
// 這裡只負責 key → 顏色。跟 apps/server/src/services/colors.js 的 COLOR_KEYS 保持同一份清單。
// 色相刻意避開狀態燈（amber = WAITING、green = BUSY）的語意：標記色只畫成色條 / 色點，不畫燈號。
export const SESSION_COLORS = [
  { key: 'red', label: '紅', hex: '#ff6b6b' },
  { key: 'orange', label: '橘', hex: '#ff9a4a' },
  { key: 'yellow', label: '黃', hex: '#f2d64b' },
  { key: 'green', label: '綠', hex: '#5fd38a' },
  { key: 'teal', label: '青', hex: '#3fd6c0' },
  { key: 'blue', label: '藍', hex: '#5aa9ff' },
  { key: 'violet', label: '紫', hex: '#b48cff' },
  { key: 'pink', label: '粉', hex: '#ff7ac6' },
];

export const COLOR_KEYS = SESSION_COLORS.map((c) => c.key);

const BY_KEY = new Map(SESSION_COLORS.map((c) => [c.key, c]));

/** key → { key, label, hex }；null / 未知 key → null */
export function colorMeta(key) {
  return (key && BY_KEY.get(key)) || null;
}

/** key → hex；null / 未知 key → null（呼叫端自己決定沒顏色時怎麼畫） */
export function colorHex(key) {
  return colorMeta(key)?.hex ?? null;
}

/** session 實際要畫的顏色：自己的 color 優先，沒有就用 project 預設色 */
export function effectiveColor(session, profile) {
  return session?.color || profile?.color || null;
}
