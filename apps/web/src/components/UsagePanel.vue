<script>
// 收到 /api/system payload 的本機時間；放 module 層，元件重掛時不會把舊資料誤判成剛收到（同 DeviceStatus）
const sysSeenAt = new WeakMap();
</script>

<script setup>
// 側欄底部的用量面板（DeviceStatus 的 HOST 下面）。
// 精簡模式一直顯示：Claude 目前帳號（cswap）+ Codex 目前帳號，各自的週用量 / model 視窗。
// 點帳號列展開 AccountsPopover：看所有帳號的用量、切換帳號。
// Claude 已取消 5 小時用量：這裡不畫 5h（Codex 回報的 5h 是它真的限制，照列）。
// 沒有 cswap 時退回 statusline 回報的目前帳號 1w（sessions store 的 /api/system）。
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useAccountsStore } from '../stores/accounts.js';
import { useSessionsStore } from '../stores/sessions.js';
import UsageRows from './UsageRows.vue';
import AccountsPopover from './AccountsPopover.vue';
import {
  accountName, accountTitle, activeAccount, ageSeconds, codexHidden, dedupeResets, isStale,
  relTime, splitClaudeWindows, usageWindow,
} from '../lib/usage-format.js';

const accounts = useAccountsStore();
const sessions = useSessionsStore();
const route = useRoute();

// 倒數與「x 分鐘前」每 30 秒自己走，不重新抓資料
const now = ref(Date.now());
let ticker = null;
function tick() { now.value = Date.now(); }
function onVisible() { if (!document.hidden) tick(); }
onMounted(() => {
  accounts.start();
  ticker = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  accounts.stop();
  clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisible);
});
// 資料更新時順便把時間對齊，倒數不會落後最多 30 秒
watch(() => [accounts.claude.lastFetchedAt, accounts.codex.lastFetchedAt], tick);

// ── statusline 退路的收到時間 ──
const sys = computed(() => sessions.system);
const sysReceivedAt = ref(0);
watch(sys, (v) => {
  const raw = v ? toRaw(v) : null;
  if (raw && !sysSeenAt.has(raw)) sysSeenAt.set(raw, Date.now());
  sysReceivedAt.value = raw ? sysSeenAt.get(raw) : 0;
}, { immediate: true });

// ── CLAUDE ───────────────────────────────────────────
const claudePayload = computed(() => accounts.claude.payload);
const claudeOk = computed(() => claudePayload.value?.available === true);
const claudeActive = computed(() => (claudeOk.value ? activeAccount(claudePayload.value) : null));
const claudeAge = computed(() => ageSeconds(claudeActive.value?.usage_age_seconds, accounts.claude.lastFetchedAt, now.value));
const claudeRows = computed(() => {
  const a = claudeActive.value;
  if (!a) return [];
  return dedupeResets(splitClaudeWindows(a).main.map((w) => usageWindow(w, now.value)));
});
// cswap 找不到使用中的帳號：可能是剛裝還沒 add、或目前登入不是 cswap 管的帳號（例如 /login 換過）。
// payload 分不出「真的沒登入」，所以不寫「未登入」
const claudeNote = computed(() => {
  const p = claudePayload.value;
  const a = claudeActive.value;
  if (!a) return p?.accounts?.length ? '目前帳號未納入 cswap，點上面可切換' : 'cswap 裡還沒有帳號（cswap add 加入目前帳號）';
  if (a.status && a.status !== 'ok') return `用量讀取失敗（${a.status}）`;
  return '沒有用量資料';
});

// 退路：cswap 不能用、/api/accounts 打不到（舊版 server），或 cswap 可用但找不到使用中的帳號
// → statusline 回報的目前帳號 1w（不顯示 5h）。cswap 可用時仍是 'accounts' 模式（帳號列照樣可以點開切換），只借用量列
const fallbackUsage = computed(() => (claudeOk.value && claudeActive.value ? null : sys.value?.usage ?? null));
const fallbackRows = computed(() => (fallbackUsage.value
  ? [usageWindow(fallbackUsage.value.seven_day ?? null, now.value, { key: '1w', label: '1w' })]
  : []));
const fallbackAge = computed(() => ageSeconds(fallbackUsage.value?.age_seconds, sysReceivedAt.value, now.value));
const fallbackName = computed(() => {
  const k = fallbackUsage.value?.config_key;
  return k && k !== 'default' ? k : '';
});
// 只有 server 明確說 cswap 不能用才提示安裝；API 打不到時提示也沒用
const cswapMissing = computed(() => claudePayload.value?.available === false);

const claudeMode = computed(() => {
  if (claudeOk.value) return 'accounts';
  if (fallbackUsage.value) return 'fallback';
  // 還在第一次讀取，或退路要用的 /api/system 還沒回來：先畫骨架，不要閃一下「尚未接上」
  if (!accounts.claude.loaded || !sys.value) return 'loading';
  return 'none';
});

// ── CODEX ────────────────────────────────────────────
const codexPayload = computed(() => accounts.codex.payload);
const codexActive = computed(() => activeAccount(codexPayload.value));
const codexAge = computed(() => ageSeconds(codexActive.value?.usage_age_seconds, accounts.codex.lastFetchedAt, now.value));
const codexRows = computed(() => {
  const a = codexActive.value;
  if (!a || !Array.isArray(a.windows)) return [];
  return dedupeResets(a.windows.map((w) => usageWindow(w, now.value)));
});
const codexNote = computed(() => {
  const a = codexActive.value;
  // 沒有目前帳號時，server 的 error 會寫原因（例如 keyring 裡的憑證失效或已登出）
  if (!a) return codexPayload.value?.error || '';
  if (a.status === 'pending') return '讀取用量中…';
  if (a.status && a.status !== 'ok') return a.error || '用量讀取失敗';
  return '沒有用量資料';
});

const codexMode = computed(() => {
  const p = codexPayload.value;
  if (!p) {
    if (!accounts.codex.loaded) return 'loading';
    return 'hidden'; // API 打不到（舊版 server）：不佔位置
  }
  if (codexHidden(p)) return 'hidden';
  if (p.available === false) return 'unavailable';
  return 'accounts';
});

// ── 標題列的新鮮度：以 Claude 為主（沒有就看退路 / Codex） ──
const headAge = computed(() => {
  if (claudeMode.value === 'accounts' && claudeAge.value != null) return claudeAge.value;
  if (claudeMode.value === 'fallback') return fallbackAge.value;
  if (claudeMode.value === 'accounts' && !claudeActive.value && fallbackAge.value != null) return fallbackAge.value;
  if (codexMode.value === 'accounts') return codexAge.value;
  return null;
});
const headStale = computed(() => isStale(headAge.value));
const claudeStale = computed(() => isStale(claudeAge.value));
const fallbackStale = computed(() => isStale(fallbackAge.value));
const codexStale = computed(() => isStale(codexAge.value));

// ── 帳號操作：浮層關著時也看得到「進行中」與失敗（錯誤記在 store，見 accounts.mutationError） ──
function busyText(kind) {
  const b = accounts.busy;
  if (!b || !b.startsWith(`${kind}:`)) return '';
  return b.startsWith(`${kind}:switch:`) ? '切換中…' : '處理中…';
}
// 浮層開著時由浮層自己顯示，這裡不重複
function mutationError(kind) {
  if (open.value === kind) return '';
  return accounts[kind].mutationError?.message || '';
}

const refreshing = ref(false);
async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await Promise.all([accounts.refresh(), sessions.refreshSystem()]);
  } finally {
    refreshing.value = false;
  }
}

// ── 展開浮層 ─────────────────────────────────────────
const open = ref(null); // 'claude' | 'codex' | null
const claudeBtn = ref(null);
const codexBtn = ref(null);
const anchorEl = computed(() => (open.value === 'claude' ? claudeBtn.value : open.value === 'codex' ? codexBtn.value : null));

function toggle(kind) {
  open.value = open.value === kind ? null : kind;
}

function close(restoreFocus = false) {
  const btn = anchorEl.value;
  open.value = null;
  if (restoreFocus && btn?.isConnected) btn.focus();
}

// 換頁、手機 drawer 收起來、對應區塊不見了（例如 Codex 變成不可用）→ 浮層一起關，不要留在畫面上
watch(() => route.fullPath, () => close(false));
watch(() => sessions.drawerOpen, (isOpen) => { if (!isOpen) close(false); });
watch([claudeMode, codexMode], ([c, x]) => {
  if ((open.value === 'claude' && c !== 'accounts') || (open.value === 'codex' && x !== 'accounts')) close(false);
});
</script>

<template>
  <div class="usage">
    <div class="head">
      <span class="tag">USAGE <span class="tag-sub">剩餘</span></span>
      <button
        type="button"
        class="u-refresh"
        :class="{ spin: refreshing }"
        :disabled="refreshing"
        aria-label="重新抓取用量"
        title="重新抓取用量"
        @click="refreshAll"
      ><span class="glyph">↻</span></button>
      <span
        v-if="headAge != null"
        class="fresh"
        :class="{ stale: headStale }"
        :title="headStale ? '超過 30 分鐘沒有新的用量資料' : '最近一次收到用量資料'"
      >{{ relTime(headAge) }}</span>
    </div>

    <div class="p-grid">
      <!-- CLAUDE -->
      <div v-if="claudeMode === 'loading'" class="skeleton" aria-busy="true" aria-label="讀取用量中">
        <div v-for="n in 2" :key="n" class="sk-bar"><i class="sk" /><i class="sk grow" /><i class="sk" /></div>
      </div>

      <div v-else-if="claudeMode === 'accounts'" class="prov" :class="{ stale: claudeActive ? (claudeStale || claudeActive.usage_stale) : fallbackStale }">
        <button
          ref="claudeBtn"
          type="button"
          class="p-head"
          :class="{ on: open === 'claude' }"
          aria-haspopup="dialog"
          :aria-expanded="open === 'claude'"
          :title="accountTitle(claudeActive) || '看所有 Claude 帳號、切換帳號'"
          @click="toggle('claude')"
        >
          <span class="p-tag">CLAUDE</span>
          <span class="p-name">{{ claudeActive ? accountName(claudeActive) : (fallbackName || '未納入 cswap') }}</span>
          <span v-if="busyText('claude')" class="p-busy">{{ busyText('claude') }}</span>
          <span class="caret" aria-hidden="true">{{ open === 'claude' ? '▴' : '▾' }}</span>
        </button>
        <UsageRows v-if="claudeRows.length" :rows="claudeRows" sub />
        <template v-else-if="!claudeActive && fallbackRows.length">
          <UsageRows :rows="fallbackRows" sub />
          <p class="p-note" :title="claudeNote">{{ claudeNote }}</p>
        </template>
        <p v-else class="p-note">{{ claudeNote }}</p>
        <p v-if="claudeRows.length && claudeActive?.usage_stale" class="p-note">最後已知用量（{{ claudeActive.status || '這次讀取失敗' }}）</p>
        <p v-if="mutationError('claude')" class="p-err" role="alert" :title="mutationError('claude')">
          <span class="p-err-text">{{ mutationError('claude') }}</span>
          <button type="button" class="p-x" aria-label="關閉這則錯誤" @click="accounts.clearMutationError('claude')">✕</button>
        </p>
      </div>

      <div v-else-if="claudeMode === 'fallback'" class="prov" :class="{ stale: fallbackStale }">
        <div class="p-head static">
          <span class="p-tag">CLAUDE</span>
          <span v-if="fallbackName" class="p-name">{{ fallbackName }}</span>
        </div>
        <UsageRows :rows="fallbackRows" sub />
        <p v-if="cswapMissing" class="p-note" :title="claudePayload?.error || ''">安裝 cswap 才能切換帳號</p>
      </div>

      <template v-else>
        <RouterLink to="/setup" class="setup-link">
          <span class="u-label">1w</span> 用量尚未接上 <span class="go">設定 →</span>
        </RouterLink>
        <p v-if="cswapMissing" class="p-note" :title="claudePayload?.error || ''">安裝 cswap 才能切換帳號</p>
      </template>

      <!-- CODEX -->
      <div v-if="codexMode === 'loading'" class="p-line">
        <span class="p-tag">CODEX</span><span class="p-dim">讀取中…</span>
      </div>

      <div v-else-if="codexMode === 'unavailable'" class="p-line" :title="codexPayload.error || ''">
        <span class="p-tag">CODEX</span><span class="p-dim">{{ codexPayload.error || 'Codex 目前無法使用' }}</span>
      </div>

      <div v-else-if="codexMode === 'accounts'" class="prov" :class="{ stale: codexStale }">
        <button
          ref="codexBtn"
          type="button"
          class="p-head"
          :class="{ on: open === 'codex' }"
          aria-haspopup="dialog"
          :aria-expanded="open === 'codex'"
          :title="accountTitle(codexActive) || '看所有 Codex 帳號、切換帳號'"
          @click="toggle('codex')"
        >
          <span class="p-tag">CODEX</span>
          <span class="p-name">{{ codexActive ? accountName(codexActive) : '未登入' }}</span>
          <span v-if="busyText('codex')" class="p-busy">{{ busyText('codex') }}</span>
          <span class="caret" aria-hidden="true">{{ open === 'codex' ? '▴' : '▾' }}</span>
        </button>
        <UsageRows v-if="codexRows.length" :rows="codexRows" sub />
        <p v-else-if="codexNote" class="p-note">{{ codexNote }}</p>
        <p v-if="mutationError('codex')" class="p-err" role="alert" :title="mutationError('codex')">
          <span class="p-err-text">{{ mutationError('codex') }}</span>
          <button type="button" class="p-x" aria-label="關閉這則錯誤" @click="accounts.clearMutationError('codex')">✕</button>
        </p>
      </div>
    </div>

    <AccountsPopover
      v-if="open && anchorEl"
      :key="open"
      :provider="open"
      :anchor="anchorEl"
      :now="now"
      @close="close"
    />
  </div>
</template>

<style scoped>
.usage {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--dim);
}
.tag { color: var(--amber-dim); }
.tag-sub {
  font-family: var(--cjk);
  letter-spacing: 0.08em;
  color: var(--dimmer);
}
.fresh {
  letter-spacing: 0.04em;
  color: var(--dimmer);
  white-space: nowrap;
}
.fresh.stale { color: var(--amber-dim); }

/* ↻：不要全域 button 的 [ ] 與發光 */
.u-refresh {
  margin-left: auto;
  width: 22px;
  height: 18px;
  padding: 0;
  border: none;
  font-size: 13px;
  letter-spacing: 0;
  line-height: 1;
  color: var(--dimmer);
}
.u-refresh::before,
.u-refresh::after { content: none; }
.u-refresh:hover {
  color: var(--amber);
  box-shadow: none;
}
.u-refresh .glyph { display: inline-block; }
.u-refresh.spin { opacity: 1; color: var(--amber-dim); }
.u-refresh.spin .glyph { animation: u-spin 800ms linear infinite; }

/* 整個面板一個 grid（label | bar | %），Claude 與 Codex 的 bar 左緣對齊；各區塊用 subgrid 接下去 */
.p-grid {
  display: grid;
  grid-template-columns: auto minmax(28px, 1fr) auto;
  column-gap: 8px;
  row-gap: 4px;
  align-items: center;
}
.prov {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  row-gap: 6px;
  align-items: center;
  transition: opacity 200ms;
}
.prov + .prov,
.prov + .p-line,
.p-note + .p-line,
.p-note + .prov,
.setup-link + .prov,
.setup-link + .p-line,
.skeleton + .prov,
.skeleton + .p-line { margin-top: 6px; }
.prov.stale { opacity: 0.5; filter: grayscale(1); }

/* 帳號列（點了展開浮層）：外觀是一行字，不是按鈕 */
.p-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  width: 100%;
  margin: 0;
  padding: 1px 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: none;
  text-align: left;
  color: var(--dim);
}
.p-head::before,
.p-head::after { content: none; }
button.p-head:hover { box-shadow: none; color: var(--cream); }
button.p-head:focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}
.p-tag {
  flex: none;
  color: var(--amber-dim);
  font-size: 11px;
  letter-spacing: 0.16em;
}
.p-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--cyan);
}
button.p-head:hover .p-name,
button.p-head.on .p-name { color: var(--cream); }
.caret {
  flex: none;
  font-size: 10px;
  color: var(--dimmer);
}
button.p-head:hover .caret,
button.p-head.on .caret { color: var(--amber); }
.p-busy {
  flex: none;
  font-family: var(--cjk);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--amber);
}

/* 浮層關著時的帳號操作失敗：一行紅字，可以按掉 */
.p-err {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-size: 11.5px;
  color: var(--danger);
}
.p-err-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-x {
  flex: none;
  width: 18px;
  height: 16px;
  padding: 0;
  border: none;
  font-size: 11px;
  letter-spacing: 0;
  line-height: 1;
  color: var(--dimmer);
}
.p-x::before,
.p-x::after { content: none; }
.p-x:hover { color: var(--danger); box-shadow: none; }
.p-x:focus-visible { outline: 1px solid var(--amber); outline-offset: 1px; }

.p-note {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 11.5px;
  color: var(--dimmer);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 一行灰字的 Codex 狀態（讀取中 / 不能用） */
.p-line {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 11.5px;
}
.p-line .p-tag { color: var(--dimmer); }
.p-dim {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dimmer);
}

/* ── 未接上 ── */
.usage .setup-link,
.usage .setup-link:hover {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  text-transform: none;
  text-shadow: none;
  color: var(--dim);
}
.usage .setup-link::before,
.usage .setup-link::after { content: none; display: none; }
.usage .setup-link .u-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--dim);
}
.usage .setup-link .go { color: var(--amber); margin-left: auto; }
.usage .setup-link:hover .go { color: var(--cream); }

/* ── skeleton ── */
.skeleton { grid-column: 1 / -1; }
.sk-bar {
  display: grid;
  grid-template-columns: 18px 1fr 34px;
  gap: 8px;
  margin-bottom: 6px;
}
.sk {
  display: block;
  height: 9px;
  background: var(--line-bright);
  animation: sk-pulse 1.4s ease-in-out infinite;
}
.sk.grow { width: 100%; height: 7px; align-self: center; }
@keyframes sk-pulse {
  50% { opacity: 0.4; }
}
@keyframes u-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 觸控：帳號列、↻、設定連結至少 40px */
@media (pointer: coarse) {
  .p-head {
    min-height: 40px;
    align-items: center;
  }
  .u-refresh {
    width: 40px;
    height: 40px;
    margin-top: -11px;
    margin-bottom: -11px;
    font-size: 15px;
  }
  .usage .setup-link,
  .usage .setup-link:hover { min-height: 40px; align-items: center; }
  .p-err { align-items: center; }
  .p-x {
    width: 40px;
    height: 40px;
    margin: -12px -8px -12px 0;
    font-size: 13px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
  .u-refresh.spin .glyph { animation: none; }
}
</style>
