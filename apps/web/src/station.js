// STATION：channel 根目錄裡的資源（原本側欄 WORKSPACE 的六個入口）合成一頁，用分頁切換。
// router.js（路由 / 記住上次分頁）、App.vue（側欄與行動版標題）、StationView（分頁列）共用這份清單。
export const STATION_TABS = [
  { key: 'identity', label: 'IDENTITY' },
  { key: 'skills', label: 'SKILLS' },
  { key: 'agents', label: 'AGENTS' },
  { key: 'tasks', label: 'TASKS' },
  { key: 'memory', label: 'MEMORY' },
  { key: 'kanban', label: 'KANBAN' },
];

export const STATION_TAB_KEYS = STATION_TABS.map((t) => t.key);
export const DEFAULT_STATION_TAB = 'identity';

const STORAGE_KEY = 'codd.stationTab';

export function isStationTab(v) {
  return typeof v === 'string' && STATION_TAB_KEYS.includes(v);
}

export function stationTabLabel(key) {
  return STATION_TABS.find((t) => t.key === key)?.label ?? null;
}

/** 側欄 STATION 入口（/station）要回到上次看的分頁 */
export function loadStationTab() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isStationTab(v) ? v : DEFAULT_STATION_TAB;
  } catch {
    return DEFAULT_STATION_TAB;
  }
}

export function saveStationTab(tab) {
  if (!isStationTab(tab)) return;
  try { localStorage.setItem(STORAGE_KEY, tab); } catch {}
}

/** 目前路由屬於 STATION 的哪個分頁：/station/:tab、/station/memory/:date 或各詳細頁的 meta.tab */
export function stationTabOf(route) {
  if (route?.meta?.section !== 'station') return null;
  if (isStationTab(route.params?.tab)) return route.params.tab;
  return isStationTab(route.meta.tab) ? route.meta.tab : null;
}
