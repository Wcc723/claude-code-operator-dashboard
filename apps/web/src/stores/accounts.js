import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useAuthStore } from './auth.js';

// 帳號與用量：Claude（server 包 cswap）與 Codex（server 包 codex app-server + 本機帳號庫）。
// 這兩支 API 背後都要跑子行程，server 自己有快取（Claude 20 s、Codex 目前帳號 60 s / 其他 10 分鐘），
// 這裡的輪詢只是把快取拉回來，所以間隔比 sessions 慢很多；頁面在背景時完全不抓（沒有人看得到）。
const CLAUDE_POLL_MS = 60000;
const CODEX_POLL_MS = 120000;

const FETCHERS = {
  claude: (opts) => api.getClaudeAccounts(opts),
  codex: (opts) => api.getCodexAccounts(opts),
};
const KINDS = Object.keys(FETCHERS);

function emptySlot() {
  return {
    payload: null,      // GET /api/accounts/<kind> 的回應（形狀見 SPEC 的 API 契約）
    loading: false,
    error: null,        // 這支 API 本身打不到（網路 / 舊版 server 沒有這支）；cswap / codex 不能用是 payload.available:false
    loaded: false,      // 至少完成過一次（成功或失敗）
    lastFetchedAt: 0,   // 本機收到 payload 的時間；算「x 分鐘前」用（加上 server 給的 usage_age_seconds）
    // 最後一次 mutation 失敗：{ tag, message, at }。放 store 不放浮層：浮層在切換中被關掉（點外面、換頁、drawer 收起）
    // 或重開時，錯誤還找得到。下一次 mutation 開始、或使用者看過（浮層關閉 / 側欄按掉）就清掉
    mutationError: null,
  };
}

// timers / listener / in-flight 放 module 層：不需要 reactive，也避免 HMR 時 state 裡塞 handle（同 sessions store）
let refCount = 0;
let visibilityHandler = null;
const timers = { claude: null, codex: null };
const inflight = { claude: null, codex: null };   // { refresh, promise }
// 每次 mutation（切換 / 存檔 / 改名 / 移除）前後各 +1：mutation 之前發出的 poll 帶回來的是舊資料，回來時直接丟掉
const epochs = { claude: 0, codex: 0 };

// mutation 的回應 = { ok, switched, ...GET payload }；只留 payload
function stripMeta(res) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.accounts)) return null;
  const { ok, switched, ...payload } = res;
  return payload;
}

export const useAccountsStore = defineStore('accounts', {
  state: () => ({
    claude: emptySlot(),
    codex: emptySlot(),
    busy: null, // 進行中的 mutation，例如 'claude:switch:2'、'codex:remove:<id>'；同時只允許一個
  }),

  actions: {
    // 用量面板 mount 時 start、unmount 時 stop；用 reference count，同時有兩個面板（或 HMR 重掛）也只有一組 timer
    start() {
      refCount++;
      if (refCount > 1) return;
      visibilityHandler = () => {
        if (document.hidden) this._pause();
        else this._resume();
      };
      document.addEventListener('visibilitychange', visibilityHandler);
      if (!document.hidden) this._resume();
    },

    stop() {
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0) return;
      this._pause();
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      // 登出（auth.user 清掉 → 側欄 unmount）才清資料；登入中的重掛保留舊資料，下次 start 先顯示再更新
      if (!useAuthStore().user) {
        for (const kind of KINDS) {
          epochs[kind]++;
          // 登出前發出的請求不要留著給重新登入後的第一次讀取共用：它回來時 epoch 已經不同，結果會被丟掉，
          // 新的 slot 就一直沒有資料、等到下一次輪詢（Codex 120 s）。舊 entry 的 finally 有比對 inflight === entry，不會誤清新的
          inflight[kind] = null;
          this[kind] = emptySlot();
        }
        this.busy = null;
      }
    },

    // 回到前景：立刻抓一次，再重新排輪詢
    _resume() {
      this._pause();
      for (const kind of KINDS) this._fetch(kind);
      timers.claude = setInterval(() => this._fetch('claude'), CLAUDE_POLL_MS);
      timers.codex = setInterval(() => this._fetch('codex'), CODEX_POLL_MS);
    },

    _pause() {
      for (const kind of KINDS) {
        if (timers[kind]) clearInterval(timers[kind]);
        timers[kind] = null;
      }
    },

    // refresh：帶 ?refresh=1 叫 server 重跑 cswap / 重新探測（server 端有節流）
    // force：mutation 之後用 — 先等進行中的請求（可能是 mutation 前發出的舊資料）再重抓
    _fetch(kind, { refresh = false, force = false } = {}) {
      const cur = inflight[kind];
      if (cur && !force && (!refresh || cur.refresh)) return cur.promise;
      const prev = cur?.promise ?? null;
      const entry = { refresh, promise: null };
      entry.promise = (async () => {
        if (prev) await prev.catch(() => {});
        const epoch = epochs[kind];
        this[kind].loading = true;
        try {
          const data = await FETCHERS[kind]({ refresh });
          if (epoch !== epochs[kind]) return;
          this._apply(kind, data);
        } catch (e) {
          if (epoch === epochs[kind]) this[kind].error = e.message || '讀取失敗';
        } finally {
          if (epoch === epochs[kind]) this[kind].loaded = true;
          if (inflight[kind] === entry) {
            inflight[kind] = null;
            this[kind].loading = false;
          }
        }
      })();
      inflight[kind] = entry;
      return entry.promise;
    },

    _apply(kind, payload) {
      if (!payload || typeof payload !== 'object') return;
      const slot = this[kind];
      slot.payload = payload;
      slot.error = null;
      slot.loaded = true;
      slot.lastFetchedAt = Date.now();
    },

    // 手動 ↻：不帶 kind = 兩個都重抓
    refresh(kind = null) {
      const kinds = kind ? [kind] : KINDS;
      return Promise.all(kinds.map((k) => this._fetch(k, { refresh: true })));
    },

    async _mutate(kind, tag, call) {
      if (this.busy) throw new Error('另一個操作還在進行中');
      this.busy = `${kind}:${tag}`;
      this[kind].mutationError = null;
      epochs[kind]++;
      try {
        let res;
        try {
          res = await call();
        } catch (e) {
          // 失敗也可能做了一半（例如 cswap 切到一半逾時）：重抓一次讓畫面對上實際狀態，錯誤照樣丟給呼叫端顯示
          this[kind].mutationError = { tag, message: e?.message || '操作失敗', at: Date.now() };
          this._fetch(kind, { force: true });
          throw e;
        }
        epochs[kind]++;
        const payload = stripMeta(res);
        if (payload) this._apply(kind, payload);
        else await this._fetch(kind, { force: true });
        return res;
      } finally {
        this.busy = null;
      }
    },

    clearMutationError(kind) {
      if (this[kind]) this[kind].mutationError = null;
    },

    // 回傳 { from, to }（已經是目前帳號時 server 回 switched:null）
    async switchClaude(number) {
      const res = await this._mutate('claude', `switch:${number}`, () => api.switchClaudeAccount(number));
      return res?.switched ?? null;
    },

    async switchCodex(id) {
      const res = await this._mutate('codex', `switch:${id}`, () => api.switchCodexAccount(id));
      return res?.switched ?? null;
    },

    saveCodex(label) {
      const clean = typeof label === 'string' && label.trim() ? label.trim() : null;
      return this._mutate('codex', 'save', () => api.saveCodexAccount(clean));
    },

    renameCodex(id, label) {
      const clean = typeof label === 'string' && label.trim() ? label.trim() : null;
      return this._mutate('codex', `rename:${id}`, () => api.renameCodexAccount(id, clean));
    },

    removeCodex(id) {
      return this._mutate('codex', `remove:${id}`, () => api.removeCodexAccount(id));
    },
  },
});
