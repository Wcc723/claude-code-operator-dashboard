<script setup>
// 側欄用量面板的「所有帳號」浮層：Claude（cswap）或 Codex（帳號庫）其中一個 provider。
// Teleport 到 body、position: fixed：.sidebar 是 overflow:hidden、手機 drawer 還有 transform，
// 放在側欄裡面會被裁掉或座標跑掉。位置跟著觸發按鈕算：左緣 / 寬度對齊側欄，底邊貼在按鈕上方，往上長。
// 所有危險操作（切換 / 移除）都是行內二次確認，不用 window.confirm（手機 PWA 上會被擋或很突兀）。
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useAccountsStore } from '../stores/accounts.js';
import UsageRows from './UsageRows.vue';
import {
  accountName, accountTitle, ageSeconds, dedupeResets, relTime, splitClaudeWindows, usageWindow,
} from '../lib/usage-format.js';

const props = defineProps({
  provider: { type: String, required: true }, // 'claude' | 'codex'
  anchor: { default: null },                   // 觸發按鈕（HTMLElement；不寫 type，Vue 的 Object 檢查會把 DOM 元素當成型別不符）
  now: { type: Number, required: true },
});
const emit = defineEmits(['close']); // payload：true = 焦點還給觸發按鈕

const store = useAccountsStore();
const el = ref(null);
const headId = `acct-pop-${props.provider}`;

const isClaude = computed(() => props.provider === 'claude');
const slot = computed(() => store[props.provider]);
const payload = computed(() => slot.value.payload);
const list = computed(() => (Array.isArray(payload.value?.accounts) ? payload.value.accounts : []));
const canSwitch = computed(() => (isClaude.value
  ? payload.value?.available === true
  : payload.value?.available !== false && payload.value?.can_switch === true));
const busy = computed(() => store.busy);

function keyOf(a) { return isClaude.value ? String(a.number) : String(a.id); }
function isBusy(tag, a) { return busy.value === `${props.provider}:${tag}:${a ? (isClaude.value ? a.number : a.id) : ''}`.replace(/:$/, ''); }

function rowsFor(a) {
  const windows = isClaude.value ? splitClaudeWindows(a).main : (Array.isArray(a.windows) ? a.windows : []);
  // 跟上一列同時重置（例如 Fable 跟 1w 差一分鐘）就不重複寫重置時間；完整時間在 title
  return dedupeResets(windows.map((w) => usageWindow(w, props.now)));
}

// Claude 已取消 5 小時用量；cswap 還有回的帳號只在這裡用小字帶一下，不畫 bar
function sessionLine(a) {
  if (!isClaude.value) return '';
  return splitClaudeWindows(a).session
    .map((w) => {
      const v = usageWindow(w, props.now);
      return `${v.label} 剩 ${v.pctText}${v.resetText ? ` · ${v.resetText}` : ''}`;
    })
    .join('　');
}

function ageText(a) {
  const s = ageSeconds(a.usage_age_seconds, slot.value.lastFetchedAt, props.now);
  return s == null ? '' : relTime(s);
}

function statusNote(a) {
  // cswap 這次讀不到（token 過期等），bar 畫的是它保留的上一次成功值：寫清楚是舊資料，不要寫「讀取失敗」
  if (a.usage_stale) return `最後已知用量（${a.status || '這次讀取失敗'}）`;
  if (!isClaude.value && a.status === 'pending') return '還沒讀到用量（背景探測中）';
  if (a.status && a.status !== 'ok') return a.error || `用量讀取失敗（${a.status}）`;
  if (!rowsFor(a).length) return '沒有用量資料';
  return '';
}

// ───── 行內操作 ─────
const pending = ref(null); // { type: 'switch' | 'remove' | 'rename' | 'save', key, value? }
const errorAt = ref(null); // { key, message }；key 'top' = 放在最上面
const done = ref('');

// mutation 失敗也記在 store（tag 例如 'switch:2'、'save'、'remove:<id>'）：
// 切換中把浮層關掉、或重開後才等到結果，這個新的浮層實例也要看得到錯誤
const storeError = computed(() => {
  const m = slot.value.mutationError;
  if (!m) return null;
  const i = m.tag.indexOf(':');
  return { key: i < 0 ? m.tag : m.tag.slice(i + 1), message: m.message };
});
// 實際顯示的錯誤：對不到任何一列（例如那個帳號已經不在清單裡）就放最上面
const shownError = computed(() => {
  const e = errorAt.value ?? storeError.value;
  if (!e) return null;
  const hasRow = e.key === 'save'
    ? !isClaude.value && list.value.some((a) => a.active)
    : list.value.some((a) => keyOf(a) === e.key);
  return hasRow ? e : { key: 'top', message: e.message };
});

function reset() {
  pending.value = null;
  errorAt.value = null;
  done.value = '';
  store.clearMutationError(props.provider);
}

async function focusSel(sel) {
  await nextTick();
  const t = el.value?.querySelector(sel);
  if (t) t.focus();
  else el.value?.focus();
}

function ask(type, a) {
  if (busy.value) return;
  reset();
  pending.value = { type, key: keyOf(a) };
  // 預設焦點放在「取消」：連按兩下 Enter 不會誤觸切換 / 移除
  focusSel(`[data-cancel="${type}-${keyOf(a)}"]`);
}

function cancel() {
  const p = pending.value;
  pending.value = null;
  if (!p) return;
  if (p.type === 'save') focusSel('[data-act="save"]');
  else focusSel(`[data-act="${p.type}-${p.key}"]`);
}

async function run(key, fn, okText) {
  errorAt.value = null;
  done.value = '';
  // 進行中「確定 / 儲存」會 disabled（瀏覽器把焦點丟回 body），結束後確認區整塊拆掉：
  // 先把焦點停在浮層本身，Tab 循環（掛在浮層的 keydown）才接得住
  el.value?.focus({ preventScroll: true });
  try {
    const text = await fn();
    pending.value = null;
    done.value = text ?? okText;
    focusSel('.ap-done');
  } catch (e) {
    pending.value = null;
    errorAt.value = { key, message: e.message || '操作失敗' };
    // 錯誤訊息可以 focus（tabindex=-1），找不到就退回浮層本身（focusSel 的 fallback）
    focusSel('.ap-err');
  }
}

function confirmSwitch(a) {
  const name = accountName(a);
  return run(keyOf(a), async () => {
    const sw = isClaude.value ? await store.switchClaude(a.number) : await store.switchCodex(a.id);
    return sw ? `已切換到 ${name}` : `${name} 已經是目前帳號`;
  });
}

function confirmRemove(a) {
  const name = accountName(a);
  return run(keyOf(a), () => store.removeCodex(a.id).then(() => null), `已從帳號庫移除 ${name}`);
}

function startRename(a) {
  if (busy.value) return;
  reset();
  pending.value = { type: 'rename', key: keyOf(a), value: a.label ?? '' };
  focusSel(`[data-input="rename-${keyOf(a)}"]`);
}

function submitRename(a) {
  const value = pending.value?.value ?? '';
  return run(keyOf(a), () => store.renameCodex(a.id, value).then(() => null), '已更新名稱');
}

function startSave() {
  if (busy.value) return;
  reset();
  pending.value = { type: 'save', key: 'save', value: '' };
  focusSel('[data-input="save"]');
}

function submitSave() {
  const value = pending.value?.value ?? '';
  return run('save', () => store.saveCodex(value).then(() => null), '已加入帳號庫');
}

const refreshing = computed(() => slot.value.loading);
function refresh() {
  store.refresh(props.provider);
}

// ───── 位置 ─────
const pos = ref({});
let raf = 0;
let ro = null;

function place() {
  raf = 0;
  const a = props.anchor;
  if (!a || !a.isConnected) return;
  const ar = a.getBoundingClientRect();
  const side = a.closest('.sidebar');
  const docEl = document.documentElement;
  const vw = docEl.clientWidth;
  const vh = docEl.clientHeight;
  let left;
  let width;
  let topLimit;
  if (side) {
    const sr = side.getBoundingClientRect();
    // clientLeft / clientWidth：不含側欄右邊那條 border，浮層剛好蓋住側欄內容區
    left = sr.left + side.clientLeft;
    width = side.clientWidth;
    topLimit = sr.top + 8;
  } else {
    width = Math.min(340, vw - 16);
    left = Math.max(8, Math.min(ar.left, vw - width - 8));
    topLimit = 8;
  }
  const bottomEdge = ar.top - 4;
  pos.value = {
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
    bottom: `${Math.round(Math.max(0, vh - bottomEdge))}px`,
    maxHeight: `${Math.round(Math.max(140, bottomEdge - topLimit))}px`,
  };
}

// 等 App 依 visualViewport 更新完 --app-h / --app-top（同一個事件）再量
function schedule() {
  if (!raf) raf = requestAnimationFrame(place);
}

// 觸發按鈕所在的區塊捲動（矮視窗時側欄底部會自己捲）→ 按鈕位置變了，浮層跟著重新定位；浮層自己內部捲動不用管
function onAnyScroll(e) {
  if (el.value?.contains(e.target)) return;
  schedule();
}

// ───── 關閉 / 鍵盤 ─────
function onDocPointer(e) {
  const t = e.target;
  if (el.value?.contains(t) || props.anchor?.contains(t)) return;
  emit('close', false);
}

function onWindowKey(e) {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  // 不讓 App 的 Esc 順便把手機 drawer 關掉：一次 Esc 只退一層
  e.stopPropagation();
  e.preventDefault();
  if (pending.value && !busy.value) {
    cancel();
    return;
  }
  emit('close', true);
}

// Teleport 到 body 後，Tab 走出浮層會跑到網址列；在浮層內循環
function onKeydown(e) {
  if (e.key !== 'Tab' || !el.value) return;
  const items = [...el.value.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
    .filter((x) => x.offsetParent !== null);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === el.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last
    // 焦點在最後一個按鈕之後的 tabindex=-1 元素上（例如最後一列的錯誤訊息）：也繞回第一個，不要跑出浮層
    || (last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING))) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  place();
  document.addEventListener('pointerdown', onDocPointer, true);
  window.addEventListener('keydown', onWindowKey, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', onAnyScroll, true);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  if (typeof ResizeObserver !== 'undefined' && props.anchor) {
    // 側欄高度變了（鍵盤彈出）或底部區塊內容變了（資料更新）→ 觸發按鈕位置會跟著動
    ro = new ResizeObserver(schedule);
    const side = props.anchor.closest('.sidebar');
    const foot = props.anchor.closest('.sb-foot') || props.anchor.parentElement;
    if (side) ro.observe(side);
    if (foot) ro.observe(foot);
  }
  await nextTick();
  el.value?.focus({ preventScroll: true });
});

onUnmounted(() => {
  // 浮層開著時顯示過的錯誤算看過了，關掉就清；還在進行中（關掉時結果還沒回來）就留著，讓側欄顯示
  if (!store.busy?.startsWith(`${props.provider}:`)) store.clearMutationError(props.provider);
  if (raf) cancelAnimationFrame(raf);
  ro?.disconnect();
  document.removeEventListener('pointerdown', onDocPointer, true);
  window.removeEventListener('keydown', onWindowKey, true);
  window.removeEventListener('resize', schedule);
  document.removeEventListener('scroll', onAnyScroll, true);
  window.visualViewport?.removeEventListener('resize', schedule);
  window.visualViewport?.removeEventListener('scroll', schedule);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="acct-pop"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="headId"
      tabindex="-1"
      :style="pos"
      @keydown="onKeydown"
    >
      <header class="ap-head">
        <span :id="headId" class="ap-title">
          <span class="ap-tag">{{ isClaude ? 'CLAUDE' : 'CODEX' }}</span>
          <span class="ap-sub">帳號 · {{ list.length }}</span>
        </span>
        <button
          type="button"
          class="ap-icon"
          :class="{ spin: refreshing }"
          :disabled="refreshing"
          :aria-label="isClaude ? '重新讀取 Claude 帳號用量' : '重新探測 Codex 帳號用量'"
          :title="isClaude ? '重新讀取（cswap）' : '重新探測所有帳號（會花幾秒）'"
          @click="refresh"
        ><span class="glyph">↻</span></button>
        <button type="button" class="ap-icon" aria-label="關閉" title="關閉（Esc）" @click="emit('close', true)">✕</button>
      </header>

      <div class="ap-body">
        <p class="ap-hint">
          {{ isClaude
            ? '切換後新開的 session 會用新帳號；執行中的 session 建議重開。'
            : '切換後執行中的 Codex 需要重開才會換帳號。' }}
        </p>
        <p v-if="!isClaude && payload && payload.can_switch === false" class="ap-warn">
          {{ payload.error || '目前的 Codex 登入方式不能切換帳號' }}
        </p>
        <p v-if="slot.error" class="ap-warn">無法更新：{{ slot.error }}</p>
        <p v-if="done" class="ap-done" role="status" tabindex="-1">{{ done }}</p>
        <p v-if="shownError?.key === 'top'" class="ap-err" role="alert" tabindex="-1">{{ shownError.message }}</p>

        <p v-if="!list.length" class="ap-empty">
          {{ isClaude ? 'cswap 裡還沒有帳號。' : '還沒有 Codex 帳號：在主機上執行 codex login 登入後，回來按 ↻。' }}
        </p>

        <ul class="ap-list">
          <li
            v-for="a in list"
            :key="keyOf(a)"
            class="ap-acct"
            :class="{ active: a.active }"
          >
            <div class="ap-line">
              <span class="ap-lamp" aria-hidden="true">{{ a.active ? '●' : '○' }}</span>
              <span class="ap-name" :title="accountTitle(a)">{{ accountName(a) }}</span>
              <span v-if="a.active" class="ap-badge">ACTIVE</span>
              <template v-else-if="canSwitch && (isClaude || a.saved !== false)">
                <span v-if="isBusy('switch', a)" class="ap-busy" role="status">切換中…</span>
                <button
                  v-else-if="pending?.type !== 'switch' || pending.key !== keyOf(a)"
                  type="button"
                  class="ap-btn go"
                  :data-act="`switch-${keyOf(a)}`"
                  :disabled="!!busy"
                  @click="ask('switch', a)"
                >切換</button>
              </template>
            </div>

            <div class="ap-meta">
              <span v-if="a.email_masked && a.email_masked !== accountName(a)" :title="a.email || ''">{{ a.email_masked }}</span>
              <span v-if="a.plan">{{ a.plan }}</span>
              <span v-if="ageText(a)" class="ap-age">{{ ageText(a) }}</span>
            </div>

            <div v-if="pending?.type === 'switch' && pending.key === keyOf(a)" class="ap-confirm">
              <span class="ap-q">確定切換到 {{ accountName(a) }}？</span>
              <button type="button" class="ap-btn go" :disabled="!!busy" @click="confirmSwitch(a)">確定</button>
              <button
                type="button"
                class="ap-btn"
                :data-cancel="`switch-${keyOf(a)}`"
                :disabled="!!busy"
                @click="cancel"
              >取消</button>
            </div>

            <UsageRows v-if="rowsFor(a).length" class="ap-rows" :class="{ 'ap-stale': a.usage_stale }" :rows="rowsFor(a)" />
            <p v-if="statusNote(a)" class="ap-note">{{ statusNote(a) }}</p>
            <p v-if="sessionLine(a)" class="ap-small" title="Claude 已取消 5 小時用量限制；cswap 仍有回報時僅供參考">{{ sessionLine(a) }}</p>

            <template v-if="!isClaude">
              <p v-if="a.limit_reached" class="ap-small crit">已達用量上限（{{ a.limit_reached }}）</p>
              <p v-if="a.reset_credits_available > 0" class="ap-small">有 {{ a.reset_credits_available }} 次免費重置</p>

              <!-- 目前帳號還沒存進帳號庫：切走之前要先存，不然憑證就沒了 -->
              <div v-if="a.active && a.saved === false && canSwitch" class="ap-actions">
                <span class="ap-small warn">還沒存進帳號庫</span>
                <button
                  v-if="pending?.type !== 'save'"
                  type="button"
                  class="ap-btn go"
                  data-act="save"
                  :disabled="!!busy"
                  @click="startSave"
                >加入帳號庫</button>
              </div>
              <form
                v-if="a.active && pending?.type === 'save'"
                class="ap-form"
                @submit.prevent="submitSave"
              >
                <input
                  v-model="pending.value"
                  data-input="save"
                  type="text"
                  maxlength="40"
                  placeholder="名稱（選填）"
                  aria-label="帳號名稱（選填）"
                  autocomplete="off"
                  :disabled="!!busy"
                />
                <button type="submit" class="ap-btn go" :disabled="!!busy">{{ isBusy('save') ? '儲存中…' : '加入' }}</button>
                <button type="button" class="ap-btn" :disabled="!!busy" @click="cancel">取消</button>
              </form>
              <p v-if="shownError?.key === 'save' && a.active" class="ap-err" role="alert" tabindex="-1">{{ shownError.message }}</p>

              <!-- 已存的帳號：改名 / 移除 -->
              <template v-if="a.saved">
                <form
                  v-if="pending?.type === 'rename' && pending.key === keyOf(a)"
                  class="ap-form"
                  @submit.prevent="submitRename(a)"
                >
                  <input
                    v-model="pending.value"
                    :data-input="`rename-${keyOf(a)}`"
                    type="text"
                    maxlength="40"
                    placeholder="名稱（留空 = 用 email）"
                    aria-label="帳號名稱"
                    autocomplete="off"
                    :disabled="!!busy"
                  />
                  <button type="submit" class="ap-btn go" :disabled="!!busy">{{ isBusy('rename', a) ? '儲存中…' : '儲存' }}</button>
                  <button type="button" class="ap-btn" :disabled="!!busy" @click="cancel">取消</button>
                </form>
                <div v-else-if="pending?.type === 'remove' && pending.key === keyOf(a)" class="ap-confirm">
                  <span class="ap-q">從帳號庫移除 {{ accountName(a) }}？</span>
                  <button type="button" class="ap-btn danger" :disabled="!!busy" @click="confirmRemove(a)">
                    {{ isBusy('remove', a) ? '移除中…' : '移除' }}
                  </button>
                  <button
                    type="button"
                    class="ap-btn"
                    :data-cancel="`remove-${keyOf(a)}`"
                    :disabled="!!busy"
                    @click="cancel"
                  >取消</button>
                </div>
                <div v-else class="ap-actions">
                  <button
                    type="button"
                    class="ap-btn"
                    :data-act="`rename-${keyOf(a)}`"
                    :disabled="!!busy"
                    @click="startRename(a)"
                  >改名</button>
                  <button
                    type="button"
                    class="ap-btn"
                    :data-act="`remove-${keyOf(a)}`"
                    :disabled="!!busy"
                    @click="ask('remove', a)"
                  >移除</button>
                </div>
              </template>
            </template>

            <p v-if="shownError && shownError.key === keyOf(a)" class="ap-err" role="alert" tabindex="-1">{{ shownError.message }}</p>
          </li>
        </ul>

        <p v-if="!isClaude" class="ap-help">
          要加入另一個帳號：先把目前帳號加入帳號庫，再到主機上直接執行
          <code>codex login</code> 登入另一個帳號（主機開不了瀏覽器就用 <code>codex login --device-auth</code>），
          登入後回來按 ↻，再按「加入帳號庫」。
          不要先執行 <code>codex logout</code>：它會到 OpenAI 撤銷目前的登入，帳號庫裡存的那份也會跟著失效。
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.acct-pop {
  position: fixed;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(255, 176, 0, 0.08);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.4;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--bone);
  text-transform: none;
  overflow: hidden;
  outline: none;
  animation: ap-in 120ms ease-out;
}

.ap-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 12px;
  border-bottom: 1px dashed var(--line-bright);
}
.ap-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.16em;
}
.ap-tag { color: var(--amber); }
.ap-sub {
  font-family: var(--cjk);
  letter-spacing: 0.08em;
  color: var(--dimmer);
}

/* 圖示按鈕：不要全域 button 的 [ ] 與發光 */
.ap-icon {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  font-size: 14px;
  letter-spacing: 0;
  color: var(--dim);
  line-height: 1;
}
.ap-icon::before,
.ap-icon::after { content: none; }
.ap-icon:hover {
  color: var(--amber);
  box-shadow: none;
}
.ap-icon .glyph { display: inline-block; }
.ap-icon.spin { opacity: 1; }
.ap-icon.spin .glyph { animation: ap-spin 800ms linear infinite; }

.ap-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 12px 12px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-bright) transparent;
}

.ap-hint,
.ap-help {
  margin: 0 0 6px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dim);
}
.ap-help {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.ap-help code {
  font-size: 11px;
  color: var(--cream);
  background: var(--bg);
  padding: 0 3px;
  word-break: break-all;
}
.ap-warn,
.ap-err,
.ap-done,
.ap-empty {
  margin: 0 0 6px;
  font-size: 11.5px;
  line-height: 1.5;
}
.ap-warn { color: var(--amber-dim); }
.ap-err { color: var(--danger); margin: 4px 0 0 16px; outline: none; }
.ap-done { color: var(--success); outline: none; }
.ap-empty { color: var(--dimmer); }

.ap-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ap-acct {
  padding: 9px 0 10px;
  border-top: 1px dashed var(--line);
}
.ap-acct:first-child { border-top: none; }
.ap-rows.ap-stale { opacity: 0.5; filter: grayscale(1); }

.ap-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 24px;
}
.ap-lamp {
  flex: none;
  width: 8px;
  font-size: 9px;
  color: var(--dimmer);
}
.ap-acct.active .ap-lamp {
  color: var(--success);
  text-shadow: 0 0 6px rgba(124, 255, 154, 0.5);
}
.ap-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--cream);
}
.ap-acct:not(.active) .ap-name { color: var(--bone); }
.ap-badge {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--success);
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--success);
}
.ap-busy {
  flex: none;
  font-size: 11.5px;
  color: var(--amber);
}

.ap-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 1px 0 6px 16px;
  font-size: 11px;
  color: var(--dimmer);
  min-width: 0;
}
.ap-meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ap-age { margin-left: auto; }

.ap-rows { margin-left: 16px; }
.ap-note,
.ap-small {
  margin: 4px 0 0 16px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--dimmer);
}
.ap-note { color: var(--dim); }
.ap-small.warn { color: var(--amber-dim); margin: 0; }
.ap-small.crit { color: var(--danger); }

.ap-confirm,
.ap-actions,
.ap-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 6px 0 4px 16px;
}
.ap-q {
  flex: 1 1 100%;
  font-size: 11.5px;
  color: var(--amber);
  overflow-wrap: anywhere;
}
.ap-actions .ap-small.warn { flex: 1; }

/* 小按鈕：保留全域的 [ ] 外觀，只縮小 */
.ap-btn {
  flex: none;
  padding: 1px 6px;
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: none;
  color: var(--bone);
  white-space: nowrap;
}
.ap-btn.go {
  color: var(--amber);
  border-color: var(--amber-dim);
}
.ap-btn.go:hover {
  background: var(--amber);
  color: #000;
}
.ap-btn.go:hover::before,
.ap-btn.go:hover::after { color: #000; }
.ap-btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}

.ap-form input {
  flex: 1 1 120px;
  min-width: 0;
  padding: 3px 8px;
  font-size: 13px;
}

.acct-pop :is(button, input):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

/* 觸控：所有可點的東西至少 40px 高 */
@media (pointer: coarse) {
  .ap-icon {
    width: 40px;
    height: 40px;
  }
  .ap-btn {
    min-height: 40px;
    padding: 0 12px;
    font-size: 13px;
  }
  .ap-form input {
    min-height: 40px;
    font-size: 16px; /* iOS 小於 16px 會在 focus 時放大整頁 */
  }
  .ap-line { min-height: 40px; }
}

@keyframes ap-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes ap-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .acct-pop { animation: none; }
  .ap-icon.spin .glyph { animation: none; }
}
</style>
