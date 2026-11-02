<script setup>
// 終端機的連結面板：點到一個連結（mode = link），或「連結」按鈕列出整個 buffer 的網址（mode = list）。
// 桌面（滑鼠）是貼在連結 / 按鈕旁邊的小浮層；觸控是底部 sheet（有背景遮罩，按鈕至少 40px 高）。
// Teleport 到 body、position: fixed：不被 .sd / .pane 的 overflow 裁掉。
//
// 安全：網址只用文字插值顯示（不用 v-html），看不見的控制字元換成 �、太長截斷；複製一律用完整網址。
// 「開啟」只開 http(s)（新分頁、noopener，拿掉 @ 前面的帳號密碼），其他（file:// javascript: …）只給「複製」。
// 網頁連結另外顯示「前往 <主機>」：網址很長、@ 前面塞一大串、或用 \ 騙人時，一眼看得出真正去哪裡。
//
// 關閉：Esc、點外面（浮層）/ 點遮罩（sheet）、取消、做完動作；原因透過 close 事件交給父層決定 focus 要回哪裡。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { displayUrl, webHref, webTarget } from '../lib/terminal-links.js';
import { copyText, openWebUrl } from '../lib/link-actions.js';

const props = defineProps({
  mode: { type: String, default: 'link' },        // 'link' | 'list'
  items: { type: Array, default: () => [] },       // [{ url, osc }]
  variant: { type: String, default: 'popover' },  // 'popover' | 'sheet'
  anchor: { type: Object, default: null },        // { left, right, top, bottom }（client 座標）
  align: { type: String, default: 'start' },      // 浮層對齊錨點左緣（start）或右緣（end）
  // 點這裡不算「點外面」：元素（開關按鈕自己會處理），或 (pointerdown 事件) => boolean（例如點在同一個連結上）
  ignore: { type: [Object, Function], default: null },
});
const emit = defineEmits(['close']);

// 「已複製」顯示多久；單一連結複製完稍等一下再關（讓人看到回饋）
const COPIED_MS = 1600;
const LINK_CLOSE_AFTER_COPY_MS = 900;
// sheet 剛出現的這段時間內點到遮罩不算「點外面」：雙擊連結、或滑入動畫還沒跑完又點一下，不會一開就關
const BACKDROP_GUARD_MS = 350;

const el = ref(null);
const uid = Math.random().toString(36).slice(2, 8);
const headId = `tl-head-${uid}`;
const isSheet = computed(() => props.variant === 'sheet');
const isList = computed(() => props.mode === 'list');

const rows = computed(() => props.items.map((it) => {
  const url = String(it?.url ?? '');
  const target = webTarget(url);
  const shown = displayUrl(url);
  return {
    url,
    web: !!target,
    host: target?.host ?? '',
    userinfo: !!target?.userinfo,
    shown,
    // 自動複製失敗時給人手動選取的內容：原文。原文有看不見的字元（雙向文字控制之類）時，
    // 網頁連結改用正規化後的網址（同一個目的地，那些字元變成 %xx，欄位裡不會被重新排列）
    manualText: shown.replaced ? (webHref(url) ?? url) : url,
    // 不是網頁連結又有看不見的字元：手動複製的是原文，提醒一下
    hidden: !target && shown.replaced,
  };
}));

const title = computed(() => {
  if (isList.value) return '終端機裡的連結';
  return rows.value[0]?.web ? '連結' : '連結（只能複製）';
});

const copied = ref(-1);
const manual = ref(-1);   // 自動複製失敗：這一列改成可選取的欄位
let copiedTimer = null;
let closeTimer = null;
let closed = false;

function close(reason) {
  if (closed) return;
  closed = true;
  emit('close', reason);
}

function open(r) {
  if (openWebUrl(r.url)) close('action');
}

function selectAll(ev) {
  const t = ev?.target;
  if (!t || typeof t.setSelectionRange !== 'function') return;
  try { t.select(); t.setSelectionRange(0, t.value.length); } catch {}
}

async function copy(r, i) {
  manual.value = -1;
  clearTimeout(copiedTimer);
  clearTimeout(closeTimer);
  const how = await copyText(r.url);
  if (closed) return;
  if (how) {
    copied.value = i;
    copiedTimer = setTimeout(() => { copied.value = -1; }, COPIED_MS);
    if (!isList.value) closeTimer = setTimeout(() => close('action'), LINK_CLOSE_AFTER_COPY_MS);
    return;
  }
  copied.value = -1;
  manual.value = i;
  await nextTick();
  const ta = el.value?.querySelector('.tl-manual');
  if (ta) {
    ta.focus({ preventScroll: true });
    selectAll({ target: ta });
  }
  place();
}

// ───── 浮層定位（sheet 由 CSS 貼底）─────
const pos = ref(null);
const MARGIN = 8;
const GAP = 6;

function place() {
  if (isSheet.value || !el.value) return;
  const w = el.value.offsetWidth;
  const h = el.value.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const a = props.anchor;
  let left;
  let top;
  if (a) {
    left = props.align === 'end' ? a.right - w : a.left;
    top = a.bottom + GAP;
    // 下面放不下就放上面
    if (top + h > vh - MARGIN && a.top - GAP - h >= MARGIN) top = a.top - GAP - h;
  } else {
    left = (vw - w) / 2;
    top = (vh - h) / 3;
  }
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
  pos.value = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
}

// 量好尺寸之前先放在畫面外（不用 visibility: hidden，那樣 focus 不進去）
const popStyle = computed(() => (isSheet.value ? null : (pos.value || { left: '-9999px', top: '0px' })));

// ───── 事件 ─────
function ignored(ev) {
  const ig = props.ignore;
  if (!ig) return false;
  if (typeof ig === 'function') {
    try { return ig(ev) === true; } catch { return false; }
  }
  return typeof ig.contains === 'function' && ig.contains(ev.target);
}

function onDocPointerDown(ev) {
  if (isSheet.value || !el.value) return;
  if (el.value.contains(ev.target) || ignored(ev)) return;
  close('outside');
}

// sheet 的遮罩：按下和放開都在遮罩上、而且不是剛出現時的那一下，才算點外面
const mountedAt = performance.now();
let backdropDown = false;
function onBackdropPointerDown(ev) {
  backdropDown = ev.target === ev.currentTarget && performance.now() - mountedAt >= BACKDROP_GUARD_MS;
}
function onBackdropClick(ev) {
  if (!isSheet.value || ev.target !== ev.currentTarget) return;
  const ok = backdropDown;
  backdropDown = false;
  if (ok) close('outside');
}

function focusables() {
  if (!el.value) return [];
  return [...el.value.querySelectorAll('button:not(:disabled), textarea, a[href]')].filter((x) => x.offsetParent !== null);
}

// window capture：Esc 不能漏到終端機（會送 ESC 給 Claude Code，中斷它）
function onKeydown(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    close('esc');
    return;
  }
  // Teleport 到 body 後，Tab 走出浮層會跑到網址列：在面板內循環
  if (ev.key === 'Tab' && el.value?.contains(document.activeElement)) {
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && (document.activeElement === first || document.activeElement === el.value)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

function onResize() { place(); }

onMounted(async () => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onResize);
  await nextTick();
  if (closed) return;
  place();
  // 浮層（滑鼠）：focus 第一個按鈕，Enter 就能開；sheet（觸控）：focus 面板本身，
  // xterm 的輸入框失焦、鍵盤收起來，sheet 不會被鍵盤蓋住
  if (isSheet.value) el.value?.focus({ preventScroll: true });
  else (focusables().find((b) => b.classList.contains('tl-btn')) || el.value)?.focus({ preventScroll: true });
});

onBeforeUnmount(() => {
  closed = true;
  clearTimeout(copiedTimer);
  clearTimeout(closeTimer);
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <Teleport to="body">
    <div
      class="tl-layer"
      :class="{ 'tl-backdrop': isSheet }"
      @pointerdown="onBackdropPointerDown"
      @click="onBackdropClick"
    >
      <section
        ref="el"
        class="tl"
        :class="[isSheet ? 'tl-sheet' : 'tl-pop', isList ? 'is-list' : 'is-link']"
        :style="popStyle"
        role="dialog"
        :aria-modal="isSheet ? 'true' : 'false'"
        :aria-labelledby="headId"
        tabindex="-1"
      >
        <header class="tl-head">
          <h3 :id="headId" class="tl-title">{{ title }}</h3>
          <span v-if="isList" class="tl-count">{{ rows.length }}</span>
          <button
            v-if="isList || !isSheet"
            type="button"
            class="tl-x"
            title="關閉"
            aria-label="關閉"
            @click="close('cancel')"
          >✕</button>
        </header>

        <p v-if="isList && !rows.length" class="tl-empty">畫面和捲動紀錄裡沒有找到網址。</p>

        <ul v-else class="tl-items">
          <li v-for="(r, i) in rows" :key="i" class="tl-item">
            <div
              :id="`tl-url-${uid}-${i}`"
              class="tl-url"
              :title="isList && !r.shown.truncated ? r.shown.text : undefined"
              translate="no"
            >{{ r.shown.text }}</div>
            <p v-if="r.web" class="tl-host" translate="no">前往 <b>{{ r.host }}</b></p>
            <p v-if="r.userinfo" class="tl-note tl-warn">網址含 @ 前面的帳號資訊，開啟時不會帶上</p>
            <p v-if="!r.web" class="tl-note">不是網頁連結，只能複製</p>
            <template v-if="manual === i">
              <textarea
                class="tl-manual"
                readonly
                rows="3"
                :value="r.manualText"
                aria-label="網址（請自行選取複製）"
                @focus="selectAll"
                @click="selectAll"
              />
              <p v-if="r.hidden" class="tl-note tl-warn">這段文字含看不見的字元（上面以 � 標示）</p>
              <p class="tl-note tl-warn" role="status">{{ isSheet ? '請長按選取後複製' : '請選取後按 ⌘C／Ctrl+C 複製' }}</p>
            </template>
            <div class="tl-actions">
              <button
                v-if="r.web"
                type="button"
                class="tl-btn go"
                :aria-describedby="`tl-url-${uid}-${i}`"
                @click="open(r)"
              >開啟</button>
              <button
                type="button"
                class="tl-btn"
                :class="{ done: copied === i }"
                :aria-describedby="`tl-url-${uid}-${i}`"
                @click="copy(r, i)"
              >{{ copied === i ? '已複製' : '複製' }}</button>
              <button
                v-if="!isList && isSheet"
                type="button"
                class="tl-btn"
                @click="close('cancel')"
              >取消</button>
            </div>
          </li>
        </ul>
        <span class="sr-live" role="status" aria-live="polite">{{ copied >= 0 ? '已複製' : '' }}</span>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 浮層：不佔版面、不擋點擊，只有 .tl 本身是 fixed */
.tl-layer { display: contents; }
.tl-backdrop {
  display: flex;
  align-items: flex-end;
  position: fixed;
  left: 0;
  right: 0;
  top: var(--app-top, 0px);
  height: var(--app-h, 100dvh);
  z-index: 300;
  background: rgba(0, 0, 0, 0.55);
  animation: tl-fade 120ms ease-out;
  /* 遮罩上拖動不要捲到後面的頁面 */
  touch-action: none;
  overscroll-behavior: contain;
}

.tl {
  display: flex;
  flex-direction: column;
  background: var(--bg-lift);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 18px var(--amber-glow);
  color: var(--bone);
  font-size: 14px;
  line-height: 1.5;
  outline: none;
}
.tl-pop {
  position: fixed;
  z-index: 300;
  width: max-content;
  min-width: 240px;
  max-width: min(560px, calc(100vw - 16px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: min(70vh, 560px);
  animation: tl-in 120ms ease-out;
}
.tl-sheet {
  width: 100%;
  max-height: 80%;
  border-left: none;
  border-right: none;
  border-bottom: none;
  /* 橫放的 iPhone：左右也要避開瀏海 / 圓角（index.html 是 viewport-fit=cover） */
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  animation: tl-up 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
  touch-action: pan-y;
}

.tl-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px dashed var(--line-bright);
}
.tl-title {
  flex: 1;
  margin: 0;
  font-family: var(--display), var(--cjk);
  font-size: 12.5px;
  font-weight: 400;
  letter-spacing: 0.14em;
  color: var(--amber);
}
.tl-count {
  font-size: 12px;
  color: var(--dimmer);
}
.tl-x {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  font-size: 14px;
  letter-spacing: 0;
  color: var(--dim);
}
.tl-x::before,
.tl-x::after { content: none; }
.tl-x:hover { color: var(--amber); box-shadow: none; }

.tl-empty {
  margin: 0;
  padding: 14px 12px;
  color: var(--dim);
}

.tl-items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  overscroll-behavior: contain;
  min-height: 0;
}
.tl-item {
  padding: 10px 12px;
}
.tl-item + .tl-item { border-top: 1px solid var(--line); }

.tl-url {
  font-family: var(--mono), var(--cjk);
  font-size: 13.5px;
  color: var(--cream);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  -webkit-touch-callout: default;
}
/* 單一連結：完整顯示、太長就在框裡捲 */
.is-link .tl-url {
  max-height: 9.5em;
  overflow: auto;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--line-bright);
}
/* 清單：每列最多三行（完整網址用「複製」拿） */
.is-list .tl-url {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}

.tl-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--dim);
}
.tl-host {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--dim);
  overflow-wrap: anywhere;
}
.tl-host b {
  font-family: var(--mono), var(--cjk);
  font-weight: 400;
  color: var(--amber);
}
.tl-warn { color: var(--amber); }
.tl-manual {
  display: block;
  width: 100%;
  margin-top: 8px;
  font-size: 13px;
  word-break: break-all;
  resize: none;
  user-select: text;
  -webkit-user-select: text;
}

.tl-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.tl-btn {
  min-height: 32px;
  padding: 2px 12px;
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: none;
  white-space: nowrap;
}
.tl-btn.go {
  color: var(--amber);
  border-color: var(--amber-dim);
}
.tl-btn.go:hover { background: var(--amber); color: #000; }
.tl-btn.go:hover::before,
.tl-btn.go:hover::after { color: #000; }
.tl-btn.done {
  color: var(--success);
  border-color: var(--success);
}

.tl :is(button, textarea):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

.sr-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 觸控：按鈕至少 40px 高、平分寬度好按 */
.tl-sheet .tl-x { width: 40px; height: 40px; }
.tl-sheet .tl-item { padding: 12px 14px; }
.tl-sheet .tl-actions { justify-content: stretch; }
.tl-sheet .tl-btn {
  flex: 1 1 0;
  min-height: 44px;
  font-size: 15px;
}
.tl-sheet.is-list .tl-btn { min-height: 40px; font-size: 14px; }
.tl-sheet .tl-manual { font-size: 16px; }
@media (pointer: coarse) {
  .tl-pop .tl-btn { min-height: 40px; }
  .tl-pop .tl-x { width: 40px; height: 40px; }
}

@keyframes tl-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes tl-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@keyframes tl-up {
  from { transform: translateY(100%); }
  to { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tl-backdrop, .tl-pop, .tl-sheet { animation: none; }
}
</style>
