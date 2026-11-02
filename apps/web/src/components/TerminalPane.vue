<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import * as pool from '../composables/terminalPool.js';
import { attachTerminalTouch, isZoomed } from '../lib/terminal-touch.js';
import { isWebUrl, visibleMatchesHref } from '../lib/terminal-links.js';
import { openWebUrl } from '../lib/link-actions.js';
import TerminalLinkSheet from './TerminalLinkSheet.vue';

const props = defineProps({
  sessionId: { type: String, required: true },
  clientId: { type: String, required: true },
  exited: { type: Boolean, default: false },
});
const emit = defineEmits(['state']);

const RESIZE_DEBOUNCE_MS = 150;
// 觸控之後瀏覽器補發的滑鼠相容事件（mousedown…）：點到連結的已經在 touchend 處理掉，
// 沒點到的照舊交給 xterm（focus、叫出鍵盤），這裡不再攔
const COMPAT_MOUSE_MS = 800;
// xterm 自己的 activate（退路）在這麼短的時間內又報同一個連結：已經處理過了，不再開一次
const LINK_DEDUPE_MS = 400;
// 沒開滑鼠追蹤時，mousedown 到 mouseup 移動超過這麼多（CSS px）就算拖曳（在選字），不開面板
const CLICK_SLOP_PX = 4;
const IS_MAC = (() => {
  try { return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || ''); } catch { return false; }
})();

const paneEl = ref(null);
const viewport = ref(null);
// 頁面被雙指放大：終端機區塊改讓瀏覽器平移（不然放大後會被困在終端機上，拖不回去）
const zoomed = ref(false);
function syncZoom() {
  zoomed.value = isZoomed(window.visualViewport?.scale);
}
const state = shallowRef(null);
let currentId = null;
let ro = null;
let roTimer = null;
let touch = null;

// ───── 連結：點到連結開面板（桌面浮層 / 手機底部 sheet）─────
// { url, osc, variant: 'popover' | 'sheet', source: 'mouse' | 'touch', anchor }
const link = shallowRef(null);
const linkItems = computed(() => (link.value ? [{ url: link.value.url, osc: link.value.osc }] : []));
let lastTouchAt = -Infinity;
let swallowMouseUp = false;
let pendingClick = null; // 沒開滑鼠追蹤時按在連結上：{ id, x, y, hit }，放開時沒拖曳、沒選字才開面板
let stopMoveWatch = null;
let offLinks = null;
let lastDirect = { url: '', t: -Infinity }; // 最近一次直接處理的連結（給 xterm 自己的 activate 退路去重）

function markDirect(url) {
  lastDirect = { url, t: performance.now() };
}

function showLink(hit, { source, event = null }) {
  if (!currentId || !hit?.url) return;
  const variant = source === 'touch' ? 'sheet' : 'popover';
  // Cmd+點（mac）/ Ctrl+點：直接開新分頁。只限 http(s)；OSC 8 連結畫面上的字看不出真正要去哪裡
  // （[這裡](…)、或寫的是 A 網站實際去 B）時也不直接開，先給面板看清楚主機
  const direct = source === 'mouse' && !!event && (IS_MAC ? event.metaKey : event.ctrlKey);
  if (direct && isWebUrl(hit.url) && (!hit.osc || visibleMatchesHref(pool.linkVisibleText(currentId, hit), hit.url))) {
    if (link.value) closeLink('action');
    openWebUrl(hit.url);
    return;
  }
  // 同一個連結的面板已經開著（雙擊、連點）：留著，不關掉重開
  const cur = link.value;
  if (cur && cur.url === hit.url && cur.variant === variant) return;
  stopMoveWatch?.();
  stopMoveWatch = null;
  link.value = {
    url: hit.url,
    osc: !!hit.osc,
    variant,
    source,
    anchor: variant === 'popover' ? pool.linkRect(currentId, hit.range) : null,
  };
  // 桌面浮層貼在連結旁邊：連結被捲走 / 改寫了位置就不對，直接關掉（只是有新輸出、連結沒動就留著）
  if (variant === 'popover') stopMoveWatch = pool.onLinkMoved(currentId, hit.range, () => closeLink('scroll'));
}

function closeLink(reason) {
  const cur = link.value;
  if (!cur) return;
  link.value = null;
  stopMoveWatch?.();
  stopMoveWatch = null;
  // 桌面：回到終端機繼續打字（安靜 focus，不搶 PTY 尺寸）；點了別的地方、開始選字就不搶 focus。
  // 觸控：不 focus（會跳出鍵盤）
  if (cur.source === 'mouse' && reason !== 'outside' && reason !== 'switch' && reason !== 'select' && currentId) {
    pool.focus(currentId, { quiet: true });
  }
}

// 面板開著時，在同一個連結上按下（雙擊、再點一次）不算「點外面」
function onSameLink(ev) {
  const cur = link.value;
  if (!cur || !currentId || !pool.isTerminalScreen(currentId, ev.target)) return false;
  return pool.linkAtPoint(currentId, ev.clientX, ev.clientY)?.url === cur.url;
}

// 桌面點連結（左鍵）。
// app 開了滑鼠追蹤（Claude Code）：在 xterm 收到 mousedown 之前攔下來（capture）。xterm 不會 focus、不會開始選取，
// 也不會把滑鼠按下 / 放開送進 PTY（不攔的話 Claude Code 會收到一次點擊）。
// 沒開滑鼠追蹤（一般 shell）：照舊交給 xterm（拖曳選取、雙擊選字），放開時沒拖曳、沒選字才開面板。
// Shift / Alt 是強制選取文字、右鍵 / 中鍵是給 app 的，都照舊交給 xterm
function onPaneMouseDown(ev) {
  swallowMouseUp = false;
  pendingClick = null;
  if (ev.button !== 0 || ev.shiftKey || ev.altKey || !currentId) return;
  if (performance.now() - lastTouchAt < COMPAT_MOUSE_MS) return;
  if (!pool.isTerminalScreen(currentId, ev.target)) return;
  const hit = pool.linkAtPoint(currentId, ev.clientX, ev.clientY);
  if (!hit) return;
  const direct = IS_MAC ? ev.metaKey : ev.ctrlKey;
  if (!direct && pool.mouseTracking(currentId) === 'none') {
    if (ev.detail > 1) {
      // 雙擊選字：面板讓開
      if (link.value?.url === hit.url) closeLink('select');
      return;
    }
    pendingClick = { id: currentId, x: ev.clientX, y: ev.clientY, hit };
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  swallowMouseUp = true;
  markDirect(hit.url);
  showLink(hit, { source: 'mouse', event: ev });
}

function onPaneMouseUp(ev) {
  // 攔下 mousedown 的那一次：mouseup 也不給 xterm（它的 Linkifier 會再觸發一次 activate、也會送放開給 app）
  if (swallowMouseUp) {
    swallowMouseUp = false;
    ev.stopPropagation();
    return;
  }
  const p = pendingClick;
  pendingClick = null;
  if (!p || p.id !== currentId || ev.button !== 0) return;
  const moved = Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > CLICK_SLOP_PX;
  if (moved || ev.detail > 1 || pool.hasSelection(currentId)) {
    // 在選字：面板讓開
    if (link.value?.variant === 'popover') closeLink('select');
    return;
  }
  markDirect(p.hit.url);
  showLink(p.hit, { source: 'mouse', event: ev });
}

function onPaneTouch() {
  lastTouchAt = performance.now();
}

function onPaneWheel() {
  if (link.value?.variant === 'popover') closeLink('scroll');
}

// 手機點一下：落在連結上就開 sheet，回傳 true 讓 touch 那邊取消這次點擊（不送滑鼠事件、不跳鍵盤）
function onTap(x, y) {
  if (!currentId) return false;
  const hit = pool.linkAtPoint(currentId, x, y);
  if (!hit) return false;
  markDirect(hit.url);
  showLink(hit, { source: 'touch' });
  return true;
}

function mount(id) {
  const el = viewport.value;
  // 切換 session：上一個 session 的慣性 / 進行中的手勢不能捲到新的
  touch?.stop();
  pendingClick = null;
  if (id !== currentId) closeLink('switch');
  if (currentId && currentId !== id) pool.detach(currentId, el);
  currentId = id || null;
  if (!currentId || !el) {
    state.value = null;
    emit('state', null);
    return;
  }
  const entry = pool.acquire(currentId, props.clientId);
  state.value = entry.state;
  // 帶上 id：父層切 session 的那一輪還拿著舊 state，要能分辨
  emit('state', { id: currentId, state: entry.state });
  // 觸控裝置不自動 focus xterm，免得一進來就彈出鍵盤
  pool.attach(currentId, el, { focus: !pool.isCoarsePointer() });
  if (props.exited) pool.markExited(currentId);
}

const showHint = computed(() => {
  const s = state.value;
  return !!s && s.follow && !s.exited && !props.exited &&
    !!s.controllerId && s.controllerId !== props.clientId;
});

const streamLabel = computed(() => {
  const s = state.value;
  if (!s || s.exited || props.exited) return '';
  if (s.stream === 'connecting') return 'CONNECTING…';
  if (s.stream === 'reconnecting') return 'RECONNECTING…';
  if (s.stream === 'closed') return 'STREAM CLOSED';
  return '';
});

// 往上捲、沒在看最新輸出時顯示「↓ 最新」
const showJump = computed(() => !!state.value?.scrolledUp);

// 按鈕本身用 tabindex=-1 + pointerdown/mousedown.prevent 不搶 focus（同 KeyBar）：
// 手機上鍵盤開著就繼續開著，桌機上點完照樣能直接打字
function jumpToBottom() {
  touch?.stop();
  if (!currentId) return;
  pool.scrollToBottom(currentId);
  // 跟隨模式：畫面比容器大，最新的輸出在 host 下半部，容器也要捲到游標（prompt）那一行
  if (state.value?.follow) scrollContainerToCursor();
}

function scrollContainerToCursor() {
  const el = viewport.value;
  const y = currentId ? pool.cursorBottomPx(currentId) : null;
  if (!el || y == null) return;
  el.scrollTop = Math.max(0, y + 24 - el.clientHeight);
  el.scrollLeft = 0;
}

function takeControl() {
  if (!currentId) return;
  pool.claim(currentId);
  if (!pool.isCoarsePointer()) pool.focus(currentId);
}

onMounted(() => {
  mount(props.sessionId);
  ro = new ResizeObserver(() => {
    clearTimeout(roTimer);
    roTimer = setTimeout(() => {
      roTimer = null;
      if (currentId) pool.containerResized(currentId);
    }, RESIZE_DEBOUNCE_MS);
  });
  ro.observe(viewport.value);
  // 觸控捲動：接在整個 .pane（含疊在終端機上的「↓ 最新」，從按鈕上開始拖也能捲）；
  // 跟隨模式捲的是 .viewport。手勢開始時才查「目前的 session」，切換 session 沿用同一組 listener
  touch = attachTerminalTouch(paneEl.value, {
    scroller: viewport.value,
    resolve: () => (currentId ? pool.touchTarget(currentId) : null),
    onTap,
  });
  const pane = paneEl.value;
  pane.addEventListener('mousedown', onPaneMouseDown, true);
  pane.addEventListener('mouseup', onPaneMouseUp, true);
  pane.addEventListener('touchstart', onPaneTouch, { capture: true, passive: true });
  pane.addEventListener('touchend', onPaneTouch, { capture: true, passive: true });
  pane.addEventListener('wheel', onPaneWheel, { capture: true, passive: true });
  // xterm 自己觸發的連結點擊（退路，例如 mousedown 沒攔到的情況）
  // 觸控補發的滑鼠事件不算（長按、雙指放大時的點擊照舊交給 xterm / app，不開面板）
  // 拖曳 / 雙擊選字結束時 xterm 也會報（沒開滑鼠追蹤時 xterm 收得到這些事件）：有選取就不算
  offLinks = pool.onLinkActivate((info) => {
    if (info.id !== currentId) return;
    const ev = info.event;
    if (performance.now() - lastTouchAt < COMPAT_MOUSE_MS || ev?.sourceCapabilities?.firesTouchEvents) return;
    if ((ev?.detail ?? 1) > 1 || pool.hasSelection(currentId)) return;
    if (info.url === lastDirect.url && performance.now() - lastDirect.t < LINK_DEDUPE_MS) return;
    showLink(info, { source: 'mouse', event: ev });
  });
  syncZoom();
  window.visualViewport?.addEventListener('resize', syncZoom);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  clearTimeout(roTimer);
  roTimer = null;
  touch?.dispose();
  touch = null;
  const pane = paneEl.value;
  if (pane) {
    pane.removeEventListener('mousedown', onPaneMouseDown, true);
    pane.removeEventListener('mouseup', onPaneMouseUp, true);
    pane.removeEventListener('touchstart', onPaneTouch, true);
    pane.removeEventListener('touchend', onPaneTouch, true);
    pane.removeEventListener('wheel', onPaneWheel, true);
  }
  offLinks?.();
  offLinks = null;
  stopMoveWatch?.();
  stopMoveWatch = null;
  pendingClick = null;
  link.value = null;
  window.visualViewport?.removeEventListener('resize', syncZoom);
  // 在 Vue 移除容器之前把 host 停回 parking，entry 留在 pool 給下次用
  if (currentId) pool.detach(currentId, viewport.value);
  currentId = null;
});

watch(() => props.sessionId, (id) => mount(id));
// store 偵測到複製分頁會換 client id
watch(() => props.clientId, (id) => pool.setClientId(id));
watch(() => props.exited, (v) => { if (v && currentId) pool.markExited(currentId); });

// 跟隨別台裝置的尺寸時畫面可能比容器大：切進跟隨模式就捲到游標（prompt）那一行
watch(() => state.value?.follow, async (on) => {
  if (!on) return;
  await nextTick();
  scrollContainerToCursor();
});

defineExpose({
  claim: () => currentId && pool.claim(currentId),
  focus: () => currentId && pool.focus(currentId),
});
</script>

<template>
  <div ref="paneEl" class="pane" :class="{ zoomed }">
    <div ref="viewport" class="viewport" :class="{ following: state?.follow }" />
    <button
      v-if="showHint"
      type="button"
      class="hint"
      @click="takeControl"
    >◇ 跟隨其他裝置的尺寸 {{ state.ptySize?.cols }}×{{ state.ptySize?.rows }} · 點此接管</button>
    <!-- 右下角：「↓ 最新」與連線狀態上下排，不會互相蓋住 -->
    <div v-if="showJump || streamLabel" class="corner">
      <button
        v-if="showJump"
        type="button"
        class="jump"
        title="捲到最新輸出"
        aria-label="捲到最新輸出"
        tabindex="-1"
        @pointerdown.prevent
        @mousedown.prevent
        @click="jumpToBottom"
      >↓ 最新</button>
      <span v-if="streamLabel" class="stream">{{ streamLabel }}</span>
    </div>
    <TerminalLinkSheet
      v-if="link"
      :key="`${link.url}|${link.variant}`"
      mode="link"
      :items="linkItems"
      :variant="link.variant"
      :anchor="link.anchor"
      :ignore="onSameLink"
      @close="closeLink"
    />
  </div>
</template>

<style scoped>
.pane {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  background: #000;
}
.viewport {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  background: #000;
  /* 觸控捲動由 lib/terminal-touch.js 處理：瀏覽器不要自己平移，也不要從這裡觸發下拉重新整理。
     單指平移關掉、雙指縮放留給瀏覽器（手勢處理本來就不管多指）。
     先寫 none 當退路：不認得 pinch-zoom 的瀏覽器會丟掉第二行，至少還是 none */
  touch-action: none;
  touch-action: pinch-zoom;
}
/* xterm 裡面有 overflow: scroll 的元素（.xterm-viewport），捲動容器會重新開放平移：一併關掉 */
.viewport :deep(*) {
  touch-action: none;
  touch-action: pinch-zoom;
}
/* 頁面被雙指放大：單指拖曳交還給瀏覽器平移畫面（手勢處理那邊同時不接手）；
   下拉重新整理仍由 html.codd-no-pull 的 overscroll-behavior 擋住 */
.pane.zoomed .viewport,
.pane.zoomed .viewport :deep(*),
.pane.zoomed .corner,
.pane.zoomed .jump {
  touch-action: pan-x pan-y pinch-zoom;
}
/* host div 由 terminalPool 建立（不帶 scoped attribute），用 :deep 套樣式。
   貼合模式：填滿容器，FitAddon 以 host 的尺寸計算 cols/rows */
.viewport :deep(.codd-term-host) {
  position: absolute;
  top: 6px;
  left: 10px;
  right: 2px;
  bottom: 4px;
}
/* 跟隨模式：host 依 xterm 內在尺寸（PTY cols × rows）撐開，超出的部分由容器捲動 */
.viewport :deep(.codd-term-host.is-follow) {
  position: relative;
  top: auto;
  left: auto;
  right: auto;
  bottom: auto;
  display: inline-block;
  vertical-align: top;
  margin: 6px 10px 4px;
}

.hint {
  position: absolute;
  top: 8px;
  right: 18px;
  z-index: 3;
  max-width: calc(100% - 36px);
  font-size: 12.5px;
  letter-spacing: 0.04em;
  text-transform: none;
  padding: 6px 12px;
  min-height: 36px;
  color: var(--amber);
  background: rgba(5, 5, 5, 0.88);
  border: 1px dashed var(--amber-dim);
  font-family: var(--mono), var(--cjk);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hint::before,
.hint::after { content: none; }
.hint:hover {
  color: #000;
  background: var(--amber);
  border-style: solid;
}

.corner {
  position: absolute;
  bottom: 8px;
  right: 18px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
  /* 「↓ 最新」疊在終端機上：從它上面開始拖也是捲終端機（.pane 上的手勢處理），瀏覽器不要自己平移 */
  touch-action: none;
  touch-action: pinch-zoom;
}
.jump {
  pointer-events: auto;
  font-size: 12.5px;
  letter-spacing: 0.06em;
  text-transform: none;
  padding: 4px 12px;
  min-height: 32px;
  color: var(--amber);
  background: rgba(5, 5, 5, 0.88);
  border: 1px solid var(--amber-dim);
  font-family: var(--mono), var(--cjk);
  white-space: nowrap;
  touch-action: none;
  touch-action: pinch-zoom;
}
.jump::before,
.jump::after { content: none; }
.jump:hover {
  color: #000;
  background: var(--amber);
}

.stream {
  font-size: 12px;
  letter-spacing: 0.14em;
  color: var(--dim);
  background: rgba(5, 5, 5, 0.85);
  border: 1px solid var(--line-bright);
  padding: 2px 10px;
  pointer-events: none;
  animation: blink-soft 1.2s ease-in-out infinite;
}
@keyframes blink-soft {
  50% { opacity: 0.45; }
}

@media (pointer: coarse) {
  .hint { min-height: 40px; }
  .jump { min-height: 40px; min-width: 40px; padding: 6px 14px; }
}

@media (max-width: 767px) {
  .viewport :deep(.codd-term-host) { top: 4px; left: 4px; right: 0; bottom: 2px; }
  .viewport :deep(.codd-term-host.is-follow) { margin: 4px; }
  /* 窄螢幕不要蓋住終端機最上面幾行：提示自成一列放在終端機上方 */
  .pane { flex-direction: column; }
  .hint {
    position: static;
    order: -1;
    flex: none;
    max-width: none;
    border-width: 0 0 1px;
    text-align: left;
  }
}
</style>
