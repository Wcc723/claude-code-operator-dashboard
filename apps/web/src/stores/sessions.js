import { defineStore } from 'pinia';
import { api } from '../api.js';

const SESSIONS_POLL_MS = 5000;
const SYSTEM_POLL_MS = 10000;
// 分頁在背景時 session 列表仍要慢慢更新：分頁標題的 (n) 等待提醒就是給背景分頁看的
// （Chrome 背景 5 分鐘後本來就會把 timer 壓到約 1 分鐘一次）。/system 在背景時完全暫停
const SESSIONS_HIDDEN_POLL_MS = 30000;

const KNOWN_STATES = new Set(['waiting', 'busy', 'idle', 'unknown']);

function randomId() {
  // crypto.randomUUID 只在 secure context（https / localhost）存在；區網 http 直連時要 fallback
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 每個分頁一個 id：多台裝置 / 多個分頁看同一個 PTY 時，用它判斷誰在控制 PTY 尺寸。
// 放 sessionStorage 讓重新整理後仍是同一個控制者；複製分頁會連 sessionStorage 一起複製，由 watchDuplicateClientId 換掉
function loadClientId() {
  try {
    const saved = sessionStorage.getItem('codd.clientId');
    if (saved && /^[A-Za-z0-9-]{1,64}$/.test(saved)) return saved;
    const id = randomId();
    sessionStorage.setItem('codd.clientId', id);
    return id;
  } catch {
    return randomId();
  }
}

// 開頁時用 BroadcastChannel 問一聲：有其他活著的分頁用同一個 id 就換新的，免得兩個分頁互搶 PTY 尺寸
let clientChannel = null;
function watchDuplicateClientId(store) {
  if (clientChannel || typeof BroadcastChannel === 'undefined') return;
  try { clientChannel = new BroadcastChannel('codd-client'); } catch { return; }
  const instance = randomId();
  clientChannel.onmessage = (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object' || m.instance === instance) return;
    if (m.type === 'hello' && m.id === store.clientId) {
      clientChannel.postMessage({ type: 'taken', id: m.id, to: m.instance, instance });
    } else if (m.type === 'taken' && m.to === instance && m.id === store.clientId) {
      const id = randomId();
      try { sessionStorage.setItem('codd.clientId', id); } catch {}
      store.clientId = id;
    }
  };
  clientChannel.postMessage({ type: 'hello', id: store.clientId, instance });
}

function loadFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function saveFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch {}
}

// 燈號：形狀 + 顏色雙重編碼（色弱也分得出 waiting）
export const STATE_META = {
  waiting: { glyph: '◆', label: 'WAITING' },
  busy: { glyph: '●', label: 'BUSY' },
  idle: { glyph: '○', label: 'IDLE' },
  unknown: { glyph: '●', label: '—' },
  ended: { glyph: '✕', label: 'EXITED' },
};

export function sessionState(s) {
  if (!s) return 'unknown';
  if (s.status && s.status !== 'running') return 'ended';
  const st = s.activity?.state;
  return KNOWN_STATES.has(st) ? st : 'unknown';
}

function ts(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// 側欄順序 = 使用者拖曳排的（server 的 order）；舊版 server 沒有 order 就依開啟時間，新的在後
function byOrder(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : Infinity;
  const ob = Number.isFinite(b.order) ? b.order : Infinity;
  return (oa === ob ? 0 : oa - ob) || (ts(a.started_at) - ts(b.started_at));
}

// 拖曳後到 server 回應前，進行中的 poll 可能帶回舊順序：沿用本地已排好的 order，避免列表跳回去又跳回來
function keepLocalOrder(next, prev) {
  const local = new Map(prev.map((x) => [x.id, x.order]));
  return next.map((x) => (local.has(x.id) ? { ...x, order: local.get(x.id) } : x));
}

// timers / listener 放 module 層：不需要 reactive，也避免 HMR 時 state 裡塞 handle
let sessionsTimer = null;
let systemTimer = null;
let visibilityHandler = null;
let sessionsInflight = null;
let systemInflight = null;
let reorderEpoch = 0;    // 每次拖曳 +1
let reorderPending = 0;  // 還沒回應的排序 PUT 數

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    items: [],
    profiles: [],
    system: null,
    loaded: false,
    error: null,
    clientId: loadClientId(),
    drawerOpen: false,
    focusMode: loadFlag('codd.focusMode'),
  }),

  getters: {
    visible: (s) => s.items.filter((x) => !x.removed),
    active() {
      return this.visible
        .filter((x) => x.status === 'running')
        .sort(byOrder);
    },
    stopped() {
      return this.visible
        .filter((x) => x.status !== 'running')
        .sort((a, b) => ts(b.exited_at) - ts(a.exited_at));
    },
    waitingCount() {
      return this.active.filter((x) => sessionState(x) === 'waiting').length;
    },
    byId: (s) => (id) => s.items.find((x) => x.id === id) ?? null,
  },

  actions: {
    start() {
      if (visibilityHandler) return;
      watchDuplicateClientId(this);
      visibilityHandler = () => {
        if (document.hidden) this._background();
        else this._resume();
      };
      document.addEventListener('visibilitychange', visibilityHandler);
      this.loadProfiles();
      if (!document.hidden) this._resume();
      else {
        this.refresh();
        this._background();
      }
    },

    stop() {
      this._pause();
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      this.items = [];
      this.profiles = [];
      this.system = null;
      this.loaded = false;
      this.error = null;
      this.drawerOpen = false;
    },

    _resume() {
      this._pause();
      this.refresh();
      this.refreshSystem();
      sessionsTimer = setInterval(() => this.refresh(), SESSIONS_POLL_MS);
      systemTimer = setInterval(() => this.refreshSystem(), SYSTEM_POLL_MS);
    },

    _background() {
      this._pause();
      sessionsTimer = setInterval(() => this.refresh(), SESSIONS_HIDDEN_POLL_MS);
    },

    _pause() {
      if (sessionsTimer) clearInterval(sessionsTimer);
      if (systemTimer) clearInterval(systemTimer);
      sessionsTimer = null;
      systemTimer = null;
    },

    // force：mutation 之後用 — 先等進行中的 poll（可能是 mutation 前發出的舊資料）再重抓
    refresh({ force = false } = {}) {
      if (sessionsInflight && !force) return sessionsInflight;
      const prev = sessionsInflight;
      let run = null;
      run = (async () => {
        if (prev) await prev.catch(() => {});
        const epoch = reorderEpoch;
        try {
          const { items } = await api.listSessions();
          const next = Array.isArray(items) ? items : [];
          this.items = reorderPending || epoch !== reorderEpoch ? keepLocalOrder(next, this.items) : next;
          this.error = null;
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loaded = true;
          if (sessionsInflight === run) sessionsInflight = null;
        }
      })();
      sessionsInflight = run;
      return run;
    },

    refreshSystem() {
      if (systemInflight) return systemInflight;
      systemInflight = (async () => {
        try {
          this.system = await api.getSystem();
        } catch {
          // 舊版 server 沒有 /api/system：保持 null，DeviceStatus 顯示 skeleton
        } finally {
          systemInflight = null;
        }
      })();
      return systemInflight;
    },

    async loadProfiles() {
      try {
        const { items } = await api.listProfiles();
        this.profiles = Array.isArray(items) ? items : [];
      } catch (e) {
        this.error = e.message;
      }
      return this.profiles;
    },

    _upsert(rec) {
      if (!rec?.id) return;
      const i = this.items.findIndex((x) => x.id === rec.id);
      if (i >= 0) this.items.splice(i, 1, { ...this.items[i], ...rec });
      else this.items.unshift(rec);
    },

    async spawn(profileId, size) {
      const s = await api.spawnSession(profileId, size);
      this._upsert(s);
      await this.refresh({ force: true });
      return this.byId(s.id) ?? s;
    },

    // ids = 執行中 session 的新順序（側欄拖曳 / 鍵盤移動）。先在本地排好，再送 server 讓其他裝置同步
    async reorder(ids) {
      const epoch = ++reorderEpoch;
      const pos = new Map(ids.map((id, i) => [id, i]));
      this.items
        .filter((x) => !pos.has(x.id))
        .sort(byOrder)
        .forEach((x, i) => pos.set(x.id, ids.length + i));
      this.items = this.items.map((x) => ({ ...x, order: pos.get(x.id) }));

      reorderPending++;
      let fresh = null;
      try {
        ({ items: fresh } = await api.reorderSessions(ids));
      } catch (e) {
        console.warn('[sessions] reorder failed:', e.message);
      } finally {
        reorderPending--;
      }
      // 期間又拖了一次：以最新那次為準，這次的回應丟掉
      if (epoch !== reorderEpoch) return;
      if (Array.isArray(fresh)) this.items = fresh;
      else await this.refresh({ force: true }); // 失敗（例如舊版 server 沒有這支 API）就回到 server 的順序
    },

    async kill(id) {
      const s = await api.killSession(id);
      this._upsert(s);
      await this.refresh({ force: true });
      return s;
    },

    async restart(id) {
      const s = await api.restartSession(id);
      this._upsert(s);
      await this.refresh({ force: true });
      return this.byId(s.id) ?? s;
    },

    async remove(id) {
      const s = await api.removeSession(id);
      this._upsert(s);
      await this.refresh({ force: true });
      return s;
    },

    setDrawer(open) {
      this.drawerOpen = !!open;
    },

    toggleFocusMode() {
      this.focusMode = !this.focusMode;
      saveFlag('codd.focusMode', this.focusMode);
    },
  },
});
