<script setup>
// canvas artifact 的無限畫布：frame（sandbox iframe）、問答卡、說明卡、便利貼都放在同一個 world 層，
// world 用 transform: translate() scale() 平移縮放（不重排）。視角數學都在 lib/canvas-viewport.js。
//
// 介面（規格 §9.2 / §9.3，ArtifactView 只透過這些使用）
// - props：view（§7.1 canvas）、draft（§4 payload）、mode（browse | comment | sticky）、readonly、
//          focusCommentId（作用中的釘選，放大加亮）、highlightCommentId（選用：滑過留言清單時在 frame 裡畫外框）
// - emits：update:draft（永遠是新物件，不改 prop）、comment-created(comment, anchor)、pin-click(commentId, anchor)、
//          update:mode（Esc 或 frame 裡按 Esc → 'browse'；用 v-model:mode 接）、
//          submit-data({ frameId, data })（frame 呼叫 window.codd.submit；資料也已寫進 draft.data）、
//          pin-move(commentId, anchor)（frame 捲動後作用中的圓點換了位置）、viewport-change（平移 / 縮放之後，每個畫面最多一次）
// - expose：focusComment(id)、fitAll()、frameToPage(frameId, clientX, clientY) → { pageX, pageY }
// anchor = { pageX, pageY, frameId, clientX, clientY }（pageX / pageY 是 viewport 座標；clientX / clientY 是 frame 裡的座標），
// 給呼叫端定位留言編輯器；畫布平移縮放後用 frameToPage 重新換算，編輯器就能跟著圓點走。
//
// 操作
// - 滾輪 / 觸控板兩指滑動 = 平移；Ctrl/⌘ + 滾輪、觸控板 pinch（Safari 的 gesture 事件）、觸控雙指 = 以指標為中心縮放。
// - 拖曳背景、frame 標題列、卡片空白處 = 平移（觸控單指也是）；超過 4px 才算拖曳，以下仍當點擊。
// - 平移 / 縮放 / 拖便利貼時在整個畫布上蓋一層透明遮罩：iframe 會把指標事件吃掉，沒有遮罩手勢一滑進 frame 就斷了。
// - browse 模式 frame 可以直接操作（捲動、點按鈕）；comment 模式 frame 進入選取模式；
//   sticky 模式 frame 不吃事件，點畫布任何地方（含 frame 上）都會貼一張便利貼。
// - 鍵盤：Esc 回 browse（文字框裡第一次 Esc 只離開編輯）、0 符合畫面、+ / − 縮放；
//   畫布本身有焦點時方向鍵平移、便利貼模式按 Enter 在中央貼一張；右下工具列可用方向鍵切換按鈕。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import ArtifactFrame from './ArtifactFrame.vue';
import CanvasQuestion from './CanvasQuestion.vue';
import CanvasNote from './CanvasNote.vue';
import CanvasSticky from './CanvasSticky.vue';
import * as V from '../../lib/canvas-viewport.js';
import { LIMITS, pinOf } from '../../stores/artifact-draft.js';

const props = defineProps({
  view: { type: Object, required: true },
  draft: { type: Object, default: null },
  mode: { type: String, default: 'browse' },
  readonly: { type: Boolean, default: false },
  focusCommentId: { type: String, default: null },
  highlightCommentId: { type: String, default: null },
});
const emit = defineEmits([
  'update:draft', 'update:mode', 'comment-created', 'pin-click', 'submit-data', 'pin-move', 'viewport-change',
]);

const MAX_COMMENTS = LIMITS.comments;
const MAX_STICKIES = LIMITS.stickies;
const STICKY_SIZE = { width: 210, height: 110 };
const KEEP_VISIBLE = 80; // 平移時內容至少留這麼多 px 在畫面裡
const NO_PINS = Object.freeze([]);
const EMPTY_DRAFT = Object.freeze({
  message: '', comments: [], answers: {}, selected: [], stickies: [], data: null,
});
const INTERACTIVE = 'input, textarea, select, button, a[href], label, [contenteditable=""], [contenteditable="true"], [data-no-pan]';

// ───── 資料 ─────
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const frames = computed(() =>
  (Array.isArray(props.view?.frames) ? props.view.frames : [])
    .filter((f) => f && typeof f.id === 'string' && typeof f.src === 'string')
    .map((f) => ({
      ...f,
      x: num(f.x, 0),
      y: num(f.y, 0),
      width: num(f.width, 1280),
      height: num(f.height, 800),
    })));
const questions = computed(() =>
  (Array.isArray(props.view?.questions) ? props.view.questions : []).filter((q) => q && typeof q.id === 'string'));
const notes = computed(() =>
  (Array.isArray(props.view?.notes) ? props.view.notes : []).filter((n) => n && typeof n.id === 'string'));

const draftObj = computed(() => props.draft || EMPTY_DRAFT);
const comments = computed(() => (Array.isArray(draftObj.value.comments) ? draftObj.value.comments : []));
const stickies = computed(() => (Array.isArray(draftObj.value.stickies) ? draftObj.value.stickies : []));
const answers = computed(() =>
  (draftObj.value.answers && typeof draftObj.value.answers === 'object' ? draftObj.value.answers : {}));
const selectedSet = computed(() =>
  new Set(Array.isArray(draftObj.value.selected) ? draftObj.value.selected : []));

const effMode = computed(() => {
  if (props.readonly) return 'browse';
  return ['browse', 'comment', 'sticky'].includes(props.mode) ? props.mode : 'browse';
});

// pins：每個 frame 一個陣列，編號依 draft.comments 的建立順序（全域，CommentList 用同一套：index + 1）。
// 只依賴 comments 與 focusCommentId，回答問題、搬便利貼都不會讓它重算。
const pinsByFrame = computed(() => {
  const map = {};
  comments.value.forEach((c, i) => {
    if (!c || typeof c.frame_id !== 'string') return;
    (map[c.frame_id] ||= []).push(pinOf(c, i + 1, props.focusCommentId));
  });
  return map;
});
const highlightByFrame = computed(() => {
  const c = props.highlightCommentId ? comments.value.find((x) => x?.id === props.highlightCommentId) : null;
  // selector 一起給：內層容器捲動的頁面，bridge 用它找到元素畫外框
  return c?.target?.rect && typeof c.frame_id === 'string'
    ? { [c.frame_id]: { ...c.target.rect, selector: c.target.selector } }
    : {};
});

// ───── draft 更新 ─────
// 同一個 tick 裡連續更新（例如建留言後馬上又改別的）時，props.draft 還沒被父層換掉，
// 所以先記住剛送出的版本當基準，父層重新 render 之後再回到 props.draft。
let pendingDraft = null;
function currentDraft() {
  return pendingDraft || draftObj.value;
}
function listOf(key) {
  const v = currentDraft()[key];
  return Array.isArray(v) ? v : [];
}
function commit(patch) {
  const next = { ...EMPTY_DRAFT, ...currentDraft(), ...patch };
  pendingDraft = next;
  emit('update:draft', next);
  nextTick(() => {
    if (pendingDraft === next) pendingDraft = null;
  });
}

function randomId(prefix) {
  const taken = new Set([...listOf('comments'), ...listOf('stickies')].map((x) => x?.id));
  for (;;) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    const id = prefix + (buf[0].toString(36) + buf[1].toString(36)).slice(0, 8);
    if (!taken.has(id)) return id;
  }
}

// ───── 提示訊息 ─────
const flashMsg = ref('');
let flashTimer = null;
function flash(msg) {
  flashMsg.value = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMsg.value = ''; }, 2600);
}
// 模式說明由 ArtifactView 顯示（畫面上方中間）；這裡只顯示上限之類的短暫提示，位置往下讓開
const hint = computed(() => flashMsg.value);

// ───── 視角 ─────
// vp 刻意不放進 reactive：平移時每一格都直接寫 DOM，不讓整個畫布重新 render。
// 只有縮放比例（工具列顯示、便利貼拖曳換算）放在 ref。
const rootEl = ref(null);
const worldEl = ref(null);
let vp = V.identity();
const zoom = ref(1);
let viewW = 0;
let viewH = 0;
let rafId = 0;
let animId = 0;
let userTouched = false; // 使用者碰過畫布（拖、滾、點、留言…）之後，容器尺寸變化就不再自動 fitAll
let fitted = false;

function writeViewport() {
  rafId = 0;
  const world = worldEl.value;
  const root = rootEl.value;
  if (!world || !root) return;
  world.style.transform = V.toTransform(vp);
  root.style.setProperty('--s', String(vp.scale));
  root.style.setProperty('--inv', String(1 / vp.scale));
  // 點狀網格跟著平移縮放；縮太小時把格距放大四倍，避免變成一片灰
  let gs = 24 * vp.scale;
  while (gs < 10) gs *= 4;
  root.style.setProperty('--gs', `${gs}px`);
  root.style.setProperty('--gx', `${vp.x}px`);
  root.style.setProperty('--gy', `${vp.y}px`);
  if (zoom.value !== vp.scale) zoom.value = vp.scale;
  emit('viewport-change');
}
function scheduleWrite() {
  if (!rafId) rafId = requestAnimationFrame(writeViewport);
}
function setViewport(next, { instant = false } = {}) {
  vp = V.normalizeViewport(next);
  if (instant) {
    if (rafId) cancelAnimationFrame(rafId);
    writeViewport();
  } else {
    scheduleWrite();
  }
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
// 動畫中的目標視角：連按 + / − 時以「要去的地方」為基準，不會卡在動畫半途的比例上
let animTarget = null;
function cancelAnim() {
  if (animId) cancelAnimationFrame(animId);
  animId = 0;
  animTarget = null;
}
function animateTo(target, duration = 260) {
  cancelAnim();
  const to = V.normalizeViewport(target);
  if (duration <= 0 || reducedMotion()) {
    setViewport(to, { instant: true });
    return;
  }
  const from = { ...vp };
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const e = 1 - (1 - t) ** 3; // easeOutCubic
    vp = V.lerpViewport(from, to, e);
    writeViewport();
    if (t < 1) animId = requestAnimationFrame(step);
    else {
      animId = 0;
      animTarget = null;
    }
  };
  animTarget = to;
  animId = requestAnimationFrame(step);
}

// 內容外框（世界座標）：優先量 DOM（問答卡、說明卡的實際高度），量不到就用資料估
let boundsCache = null;
function contentBounds() {
  if (boundsCache) return boundsCache;
  const rects = [];
  const world = worldEl.value;
  if (world) {
    for (const el of world.querySelectorAll(':scope > [data-world-item]')) {
      if (!(el instanceof HTMLElement)) continue;
      rects.push({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    }
  }
  if (!rects.length) {
    for (const f of frames.value) rects.push(f);
    for (const q of questions.value) {
      const n = Array.isArray(q.options) ? q.options.length : 0;
      rects.push({ x: num(q.x, 0), y: num(q.y, 0), width: num(q.width, 320), height: 120 + n * 36 });
    }
    for (const n of notes.value) rects.push({ x: num(n.x, 0), y: num(n.y, 0), width: num(n.width, 360), height: 120 });
    for (const s of stickies.value) rects.push({ x: num(s?.x, 0), y: num(s?.y, 0), ...STICKY_SIZE });
  }
  boundsCache = V.boundsOf(rects);
  return boundsCache;
}
function invalidateBounds() {
  boundsCache = null;
}
function constrain(next) {
  return V.constrainViewport(next, contentBounds(), viewW, viewH, KEEP_VISIBLE);
}

function fitPadding() {
  // 上方留給 frame 標題列，下方留給縮放工具列
  return viewW < 600
    ? { top: 52, right: 16, bottom: 76, left: 16 }
    : { top: 72, right: 56, bottom: 88, left: 56 };
}

function fitAll(animated = true) {
  if (!(viewW > 0 && viewH > 0)) return;
  invalidateBounds();
  const b = contentBounds();
  if (!b) return;
  const pad = fitPadding();
  let target = V.fitBounds(b, viewW, viewH, { padding: pad });
  // 縮得很小、標題列往上疊了幾層（computeHeadLevels）：上方多留那幾層的空間，疊上去的標題才不會被切掉
  const lv = Math.max(0, ...Object.values(computeHeadLevels(target.scale)));
  if (lv) target = V.fitBounds(b, viewW, viewH, { padding: { ...pad, top: pad.top + lv * HEAD_H } });
  if (animated) animateTo(target);
  else {
    cancelAnim();
    setViewport(target, { instant: true });
  }
}

function zoomAroundCenter(scale, animated = true) {
  const next = V.zoomAt(animTarget || vp, viewW / 2, viewH / 2, scale);
  userTouched = true;
  if (animated) animateTo(constrain(next), 160);
  else setViewport(constrain(next));
}
function fitAllFromUser() {
  userTouched = false;
  fitAll(true);
}
function zoomStep(dir) {
  zoomAroundCenter(V.nextZoomStep((animTarget || vp).scale, dir));
}
function zoomReset() {
  zoomAroundCenter(1);
}

// frame 的文件大小（ready 時 bridge 回報），focusComment 估算捲動位置用
const docSizes = new Map();
const frameRefs = new Map();
function setFrameRef(id, el) {
  if (el) frameRefs.set(id, el);
  else frameRefs.delete(id);
}

/** 平移到某則留言所在的 frame，並請 frame 把那個點捲到中間 */
function focusComment(id) {
  const c = comments.value.find((x) => x?.id === id);
  if (!c) return false;
  const f = frames.value.find((fr) => fr.id === c.frame_id);
  if (!f) return false;
  const cx = num(c.x, 0);
  const cy = num(c.y, 0);
  frameRefs.get(f.id)?.scrollTo(cx, cy, c.target?.selector);
  // 預估 frame 捲動後那個點在 frame 視窗裡的位置（bridge 會讓它置中，碰到文件邊緣就停）
  const doc = docSizes.get(f.id);
  const maxSX = Math.max(0, (doc?.docWidth ?? Infinity) - f.width);
  const maxSY = Math.max(0, (doc?.docHeight ?? Infinity) - f.height);
  const inX = cx - V.clamp(cx - f.width / 2, 0, maxSX);
  const inY = cy - V.clamp(cy - f.height / 2, 0, maxSY);
  // 比例：至少大到整個 frame 放得進畫面（但不超過 100%）；使用者已經放大就維持
  const fit = V.fitBounds({ x: f.x, y: f.y, width: f.width, height: f.height }, viewW, viewH, { padding: fitPadding() });
  const scale = V.clampScale(Math.max(vp.scale, fit.scale));
  userTouched = true;
  animateTo(V.centerOn({ x: 0, y: 0, scale }, f.x + inX, f.y + inY, viewW, viewH), 320);
  return true;
}

// ───── 指標手勢 ─────
const shielding = ref(false); // 手勢進行中（指標按下到放開）
const wheeling = ref(false); // 滾輪 / 觸控板手勢剛發生（停 180ms 才收）
const gesturing = ref(false); // 真的在拖（超過門檻）
const shieldOn = computed(() => shielding.value || wheeling.value);
const dragPos = shallowRef(null); // { id, x, y }：拖曳中的便利貼暫時位置
const autofocusSticky = ref(null);

const pointers = new Map(); // pointerId → { x, y }（畫布容器座標）
let gesture = null;
let rootRect = null;
let wheelTimer = null;
let lastGestureEventAt = 0;

function localPoint(e) {
  const r = rootRect || rootEl.value.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function capture(pointerId) {
  try {
    rootEl.value?.setPointerCapture(pointerId);
  } catch {
    /* pointer 已經不在（例如觸控取消） */
  }
}

function addWindowListeners() {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}
function removeWindowListeners() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
}

function stickyById(id) {
  return listOf('stickies').find((s) => s?.id === id) || null;
}

function onPointerDown(e) {
  const root = rootEl.value;
  const t = e.target instanceof Element ? e.target : null;
  if (!root || !t || t.closest('[data-board-ui]')) return;

  // 殘留的手勢（滑鼠只有一個指標、或同一個 pointerId 又按下）：先收掉再當成新的開始
  if (gesture && (e.pointerType === 'mouse' || pointers.has(e.pointerId))) endGesture();

  // 已經有一根手指在拖：第二根 → pinch（拖便利貼時不理會其他手指）
  if (gesture) {
    if (gesture.kind === 'sticky-pending' || gesture.kind === 'sticky' || pointers.size >= 2) return;
    pointers.set(e.pointerId, localPoint(e));
    const [[idA, a], [idB, b]] = [...pointers.entries()];
    gesture = { kind: 'pinch', ids: [idA, idB], a0: a, b0: b, vp0: { ...vp } };
    gesturing.value = true;
    userTouched = true;
    capture(e.pointerId);
    e.preventDefault();
    return;
  }

  const isMouse = e.pointerType === 'mouse';
  const middle = isMouse && e.button === 1;
  if (isMouse && e.button !== 0 && !middle) return;
  if (!middle) {
    const interactive = t.closest(INTERACTIVE);
    if (interactive && root.contains(interactive)) return;
    // 說明卡：滑鼠拖曳是選字（便利貼模式除外：點哪裡都是貼）
    if (isMouse && effMode.value !== 'sticky' && t.closest('[data-selectable]')) return;
  } else {
    e.preventDefault(); // 中鍵：不要自動捲動
  }

  rootRect = root.getBoundingClientRect();
  invalidateBounds();
  cancelAnim();
  userTouched = true;
  const p = localPoint(e);
  pointers.set(e.pointerId, p);

  const stickyEl = !middle && !props.readonly ? t.closest('[data-sticky-id]') : null;
  const sticky = stickyEl ? stickyById(stickyEl.getAttribute('data-sticky-id')) : null;
  if (sticky) {
    gesture = { kind: 'sticky-pending', id: sticky.id, start: p, orig: { x: num(sticky.x, 0), y: num(sticky.y, 0) } };
  } else {
    // 按下時焦點還在畫布上的文字框（剛貼的便利貼、問答卡）：這一下只當成「點掉」，不要再貼一張
    const active = document.activeElement;
    const blurOnly = !!(active && active !== root && root.contains(active) && active.matches('textarea, input, select'));
    gesture = { kind: 'pending', start: p, vp0: { ...vp }, blurOnly, middle };
  }
  // 觸控 / 筆：取消相容的 mousedown / mouseup。不然點一下之後跟著來的 mousedown 會打在剛貼好的便利貼把手上，
  // 把 pointerup 裡放進文字框的焦點搶走（手機鍵盤跳不出來）。原本 mousedown 會做的「點空白處讓文字框失焦」
  // 改在 pointerup 自己做（見 onPointerUp 的 blurOnly）。
  if (!isMouse) e.preventDefault();
  // 一按下就 capture：滑鼠拖出視窗外放開也收得到 pointerup，遮罩不會殘留
  capture(e.pointerId);
  shielding.value = true;
  addWindowListeners();
}

function onPointerMove(e) {
  if (!gesture || !pointers.has(e.pointerId)) return;
  const p = localPoint(e);
  pointers.set(e.pointerId, p);
  const g = gesture;

  if (g.kind === 'pending' || g.kind === 'sticky-pending') {
    if (!V.exceedsThreshold(p.x - g.start.x, p.y - g.start.y)) return;
    g.kind = g.kind === 'pending' ? 'pan' : 'sticky';
    gesturing.value = true;
  }

  if (g.kind === 'pan') {
    setViewport(constrain(V.panBy(g.vp0, p.x - g.start.x, p.y - g.start.y)));
  } else if (g.kind === 'pinch') {
    const a = pointers.get(g.ids[0]);
    const b = pointers.get(g.ids[1]);
    if (!a || !b) return;
    setViewport(constrain(V.pinchViewport(g.vp0, g.a0, g.b0, a, b)));
  } else if (g.kind === 'sticky') {
    const s = vp.scale;
    dragPos.value = {
      id: g.id,
      x: Math.round(g.orig.x + (p.x - g.start.x) / s),
      y: Math.round(g.orig.y + (p.y - g.start.y) / s),
    };
  }
}

function endGesture() {
  const root = rootEl.value;
  for (const id of pointers.keys()) {
    try {
      if (root?.hasPointerCapture?.(id)) root.releasePointerCapture(id);
    } catch {
      /* 已釋放 */
    }
  }
  pointers.clear();
  gesture = null;
  rootRect = null;
  shielding.value = false;
  gesturing.value = false;
  removeWindowListeners();
}

function onPointerUp(e) {
  if (!gesture || !pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;

  // pinch 放開一根：剩下那根接著平移（重新取基準點，畫面不跳）
  if (g.kind === 'pinch') {
    if (pointers.size === 1) {
      const [p] = pointers.values();
      gesture = { kind: 'pan', start: p, vp0: { ...vp } };
      return;
    }
    if (pointers.size > 1) return;
  }
  if (pointers.size > 0) return;

  endGesture();
  const cancelled = e.type === 'pointercancel';

  if (g.kind === 'sticky') {
    const pos = dragPos.value;
    dragPos.value = null;
    if (!cancelled && pos) updateSticky(pos.id, { x: pos.x, y: pos.y });
    invalidateBounds();
  } else if (g.kind === 'sticky-pending' && !cancelled) {
    // 點了便利貼的空白處（沒拖）：把游標放進文字框
    stickyRefs.get(g.id)?.focusText();
  } else if (g.kind === 'pending' && !cancelled && !g.middle) {
    if (g.blurOnly) {
      // 點空白處 = 離開正在打字的文字框（滑鼠由 mousedown 的預設行為處理；觸控的 mousedown 被取消了，這裡補做）
      if (e.pointerType !== 'mouse') blurEditing();
    } else if (effMode.value === 'sticky') {
      addStickyAt(g.start);
    }
  }
}

function blurEditing() {
  const root = rootEl.value;
  const active = document.activeElement;
  if (!root || !active || active === root || !root.contains(active)) return;
  root.focus({ preventScroll: true });
}

function onWheel(e) {
  const root = rootEl.value;
  if (!root) return;
  const ta = !e.ctrlKey && !e.metaKey && e.target instanceof Element ? e.target.closest('textarea') : null;
  if (ta && ta.scrollHeight > ta.clientHeight + 1) return;
  e.preventDefault();
  cancelAnim();
  const r = root.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (e.ctrlKey || e.metaKey) {
    // Safari 的 pinch 走 gesture 事件；同一時間又來 ctrl+wheel 就略過，避免縮兩次
    if (performance.now() - lastGestureEventAt < 120) return;
    setViewport(constrain(V.zoomBy(vp, p.x, p.y, V.wheelEventZoomFactor(e, { pageHeight: viewH || 600 }))));
  } else {
    const { dx, dy } = V.wheelDelta(e, { pageWidth: viewW || 800, pageHeight: viewH || 600 });
    setViewport(constrain(V.panBy(vp, -dx, -dy)));
  }
  userTouched = true;
  // 滾輪連續滑動時遮住 iframe，滑過 frame 不會突然變成捲 frame 裡的內容
  wheeling.value = true;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheeling.value = false; }, 180);
}

// Safari（macOS 觸控板 pinch）只送非標準的 GestureEvent，不送 ctrl+wheel。
// iOS 觸控 pinch 會同時有 pointer 事件與 gesture 事件：有觸控 pointer 在追蹤時交給 pointer 那套。
let gestureScale0 = null;
function onGestureStart(e) {
  e.preventDefault();
  if (pointers.size) return;
  cancelAnim();
  gestureScale0 = vp.scale;
  lastGestureEventAt = performance.now();
}
function onGestureChange(e) {
  e.preventDefault();
  if (pointers.size || gestureScale0 == null) return;
  lastGestureEventAt = performance.now();
  const r = rootEl.value.getBoundingClientRect();
  const x = num(e.clientX, r.left + viewW / 2) - r.left;
  const y = num(e.clientY, r.top + viewH / 2) - r.top;
  setViewport(constrain(V.zoomAt(vp, x, y, gestureScale0 * num(e.scale, 1))));
  userTouched = true;
  wheeling.value = true;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheeling.value = false; }, 180);
}
function onGestureEnd(e) {
  e.preventDefault();
  gestureScale0 = null;
}

// ───── 鍵盤 ─────
function isEditable(el) {
  return el instanceof Element
    && (el.isContentEditable || !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function onWindowKeydown(e) {
  if (e.defaultPrevented || e.isComposing || isEditable(e.target)) return;
  if (e.key === 'Escape') {
    if (effMode.value !== 'browse') emit('update:mode', 'browse');
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '0') {
    e.preventDefault();
    fitAllFromUser();
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    zoomStep(1);
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    zoomStep(-1);
  }
}

// 畫布本身有焦點（Tab 到、或點了背景）時，方向鍵平移。
// 便利貼 / 問答卡的文字框裡按 Esc：先離開編輯、焦點回到畫布（再按一次 Esc 才退出模式）
function onRootKeydown(e) {
  const root = rootEl.value;
  if (e.key === 'Escape' && !e.isComposing && e.target !== root && isEditable(e.target)) {
    e.target.blur?.();
    root?.focus({ preventScroll: true });
    return;
  }
  if (e.target !== root) return;
  // 便利貼模式下用鍵盤也能貼：Enter 在畫面中央貼一張
  if (e.key === 'Enter' && effMode.value === 'sticky' && !e.isComposing) {
    e.preventDefault();
    addStickyAt({ x: viewW / 2, y: viewH / 2 });
    return;
  }
  const step = e.shiftKey ? 240 : 60;
  const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (!d) return;
  e.preventDefault();
  userTouched = true;
  animateTo(constrain(V.panBy(animTarget || vp, d[0], d[1])), 120);
}

// 工具列：一個 Tab 停駐點，←/→/Home/End 在按鈕間移動（roving tabindex）
const toolbarEl = ref(null);
const toolIdx = ref(0);
function onToolbarKeydown(e) {
  const btns = [...(toolbarEl.value?.querySelectorAll('button') ?? [])];
  if (!btns.length) return;
  const cur = Math.max(0, btns.indexOf(document.activeElement));
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % btns.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + btns.length) % btns.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = btns.length - 1;
  if (next == null) return;
  e.preventDefault();
  toolIdx.value = next;
  btns[next].focus();
}
function onToolbarFocusin(e) {
  const btns = [...(toolbarEl.value?.querySelectorAll('button') ?? [])];
  const i = btns.indexOf(e.target);
  if (i >= 0) toolIdx.value = i;
}
const zoomPct = computed(() => Math.round(zoom.value * 100));

// ───── frame 標題列的層 ─────
// 標題列反向縮放（螢幕上固定大小），寬度 = frame 在螢幕上的寬度，但至少 HEAD_MIN px（縮很小時 frame 只剩幾十 px，
// 標題要讀得出來）。這樣窄的 frame 的標題列會伸到右邊 frame 的標題列上面：依現在的縮放比例，
// 把會重疊的往上疊一層（最多 HEAD_LEVELS 層，CSS 用 --lv 位移並畫一條引線接回 frame），不會疊字、星號也點得到。
// 從右往左排：伸出去的（左邊、窄的）那個往上疊。只在縮放比例或版面變了才重算
const HEAD_MIN = 128;
const HEAD_H = 30;
const HEAD_LEVELS = 3;
function computeHeadLevels(s) {
  const list = [...frames.value].sort((a, b) => b.x - a.x || a.y - b.y);
  const placed = [];
  const out = {};
  for (const f of list) {
    const left = f.x * s;
    const right = left + Math.max(f.width * s, HEAD_MIN);
    const top = f.y * s;
    const used = new Set();
    for (const p of placed) {
      if (Math.abs(p.top - top) >= HEAD_H) continue; // 不同列
      if (p.left < right - 1 && p.right > left + 1) used.add(p.lv);
    }
    let lv = 0;
    while (used.has(lv) && lv < HEAD_LEVELS - 1) lv += 1;
    if (lv) out[f.id] = lv;
    placed.push({ left, right, top, lv });
  }
  return out;
}
const headLevels = computed(() => computeHeadLevels(zoom.value));
const canZoomIn = computed(() => zoom.value < V.MAX_SCALE - 1e-3);
const canZoomOut = computed(() => zoom.value > V.MIN_SCALE + 1e-3);

// ───── frame 事件 ─────
function frameById(id) {
  return frames.value.find((f) => f.id === id) || null;
}

function onFrameReady(info) {
  if (info?.frameId && (info.docWidth != null || info.docHeight != null)) docSizes.set(info.frameId, info);
}

function onFramePick(info) {
  if (props.readonly || effMode.value !== 'comment') return;
  const f = frameById(info?.frameId);
  if (!f) return;
  userTouched = true;
  if (listOf('comments').length >= MAX_COMMENTS) {
    flash(`留言最多 ${MAX_COMMENTS} 則`);
    return;
  }
  const comment = {
    id: randomId('c_'),
    frame_id: f.id,
    x: Math.round(info.x),
    y: Math.round(info.y),
    text: '',
    target: info.target ?? null,
  };
  commit({ comments: [...listOf('comments'), comment] });
  emit('comment-created', comment, anchorOf(info));
}

// 給留言編輯器定位用：viewport 座標 + frame 裡的座標（之後畫布平移縮放、frame 捲動時重新換算）
function anchorOf(info) {
  return { pageX: info.pageX, pageY: info.pageY, frameId: info.frameId, clientX: info.clientX, clientY: info.clientY };
}

/** frame 裡的 client 座標 → 現在的 viewport 座標；frame 不在了回 null */
function frameToPage(frameId, clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return frameRefs.get(frameId)?.toViewport?.(clientX, clientY) ?? null;
}

// frame 裡的觸控板 pinch（bridge 有轉送時）：跟畫布背景上的 Ctrl + 滾輪一樣，以指標為中心縮放
function onFrameWheel(info) {
  const root = rootEl.value;
  if (!root || !Number.isFinite(info?.pageX) || !Number.isFinite(info?.pageY)) return;
  if (performance.now() - lastGestureEventAt < 120) return;
  cancelAnim();
  const r = root.getBoundingClientRect();
  const f = V.wheelEventZoomFactor(info, { pageHeight: viewH || 600 });
  setViewport(constrain(V.zoomBy(vp, info.pageX - r.left, info.pageY - r.top, f)));
  userTouched = true;
  wheeling.value = true;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheeling.value = false; }, 180);
}

function onFramePinClick(info) {
  emit('pin-click', info.id, anchorOf(info));
}

function onFramePinMove(info) {
  if (info?.id) emit('pin-move', info.id, anchorOf(info));
}

// frame 裡的兩指觸控 pinch（bridge 在 zoom-forward 時轉送）：跟畫布背景上的雙指一樣用 pinchViewport。
// 手指的位置是 frame 裡的座標換成的 viewport 座標，換算用的是 iframe「現在」的位置；所以新的視角要同步寫進 DOM
// （不等 rAF）：下一個 touchmove 在 frame 裡算座標時用的就是這個 transform，跟這裡下一次換算對得上。
// 等 rAF 的話兩邊會差一格，縮放會越修越歪、來回震盪。
let framePinch = null;
function onFramePinch(info) {
  const root = rootEl.value;
  if (!root || !info) return;
  if (info.phase === 'end') {
    framePinch = null;
    return;
  }
  if (gesture) return; // 畫布上已經有指標手勢在跑
  const pts = Array.isArray(info.points) ? info.points : [];
  if (pts.length < 2 || !pts.every((q) => Number.isFinite(q?.pageX) && Number.isFinite(q?.pageY))) return;
  const r = root.getBoundingClientRect();
  const a = { x: pts[0].pageX - r.left, y: pts[0].pageY - r.top };
  const b = { x: pts[1].pageX - r.left, y: pts[1].pageY - r.top };
  lastGestureEventAt = performance.now();
  userTouched = true;
  if (info.phase === 'start' || !framePinch) {
    cancelAnim();
    framePinch = { a0: a, b0: b, vp0: { ...vp } };
    return;
  }
  setViewport(constrain(V.pinchViewport(framePinch.vp0, framePinch.a0, framePinch.b0, a, b)), { instant: true });
}

// frame 裡的 Safari GestureEvent（macOS 觸控板 pinch）：跟畫布背景上的 gesture 事件一樣，以指標為中心縮放
let frameGestureScale0 = null;
function onFrameGesture(info) {
  const root = rootEl.value;
  if (!root || !info) return;
  lastGestureEventAt = performance.now();
  if (info.phase === 'end') {
    frameGestureScale0 = null;
    return;
  }
  if (pointers.size) return;
  if (info.phase === 'start' || frameGestureScale0 == null) {
    cancelAnim();
    frameGestureScale0 = vp.scale;
    return;
  }
  if (!Number.isFinite(info.pageX) || !Number.isFinite(info.pageY)) return;
  const r = root.getBoundingClientRect();
  userTouched = true;
  setViewport(constrain(V.zoomAt(vp, info.pageX - r.left, info.pageY - r.top, frameGestureScale0 * num(info.scale, 1))), { instant: true });
}

function onFramePickCancel() {
  if (effMode.value === 'comment') emit('update:mode', 'browse');
}

function onFrameSubmitData(info) {
  if (props.readonly) return;
  commit({ data: info.data });
  emit('submit-data', info);
}

function toggleSelected(fid) {
  if (props.readonly) return;
  const sel = listOf('selected');
  commit({ selected: sel.includes(fid) ? sel.filter((x) => x !== fid) : [...sel, fid] });
}

// ───── 問答 ─────
function setAnswer(qid, value) {
  if (props.readonly || typeof qid !== 'string') return;
  userTouched = true;
  const cur = currentDraft().answers;
  const next = { ...(cur && typeof cur === 'object' ? cur : {}) };
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  if (empty) delete next[qid];
  else next[qid] = value;
  commit({ answers: next });
}

// ───── 便利貼 ─────
const stickyRefs = new Map();
function setStickyRef(id, el) {
  if (el) stickyRefs.set(id, el);
  else stickyRefs.delete(id);
}
let lastStickyColor = 'yellow';

function addStickyAt(screenPt) {
  if (listOf('stickies').length >= MAX_STICKIES) {
    flash(`便利貼最多 ${MAX_STICKIES} 張`);
    return;
  }
  const w = V.screenToWorld(vp, screenPt.x, screenPt.y);
  // 點的位置落在便利貼左上角的把手附近
  const s = { id: randomId('s_'), text: '', x: Math.round(w.x - 16), y: Math.round(w.y - 14), color: lastStickyColor };
  commit({ stickies: [...listOf('stickies'), s] });
  autofocusSticky.value = s.id;
  invalidateBounds();
}

function updateSticky(id, patch) {
  if (props.readonly) return;
  if (patch.color) lastStickyColor = patch.color;
  commit({ stickies: listOf('stickies').map((s) => (s?.id === id ? { ...s, ...patch } : s)) });
  if ('x' in patch || 'y' in patch) invalidateBounds();
}

function stickyHost(id) {
  return rootEl.value?.querySelector(`[data-sticky-id="${CSS.escape(id)}"]`) || null;
}

function removeSticky(id) {
  if (props.readonly) return;
  const hadFocus = !!stickyHost(id)?.contains(document.activeElement);
  if (autofocusSticky.value === id) autofocusSticky.value = null;
  commit({ stickies: listOf('stickies').filter((s) => s?.id !== id) });
  invalidateBounds();
  if (hadFocus) rootEl.value?.focus({ preventScroll: true });
}

// 空白的便利貼失去焦點就收掉（跟留言一樣：沒寫字等於沒貼）。拖曳中、或焦點又回到同一張時不收
function onStickyBlur(id) {
  if (autofocusSticky.value === id) autofocusSticky.value = null;
  setTimeout(() => {
    const s = stickyById(id);
    if (!s || (typeof s.text === 'string' && s.text.trim())) return;
    if (gesture && gesture.id === id) return;
    if (stickyHost(id)?.contains(document.activeElement)) return;
    removeSticky(id);
  }, 200);
}

function stickyPos(s) {
  const d = dragPos.value;
  return d && d.id === s.id ? d : { x: num(s.x, 0), y: num(s.y, 0) };
}

// ───── 生命週期 ─────
// 版面（frame / 卡片的位置與大小）變了才重新 fitAll；ArtifactView 定期重抓資料時同樣的內容不會把視角拉回去
const layoutKey = computed(() => JSON.stringify([
  frames.value.map((f) => [f.id, f.x, f.y, f.width, f.height, f.src]),
  questions.value.map((q) => [q.id, q.x, q.y, q.width]),
  notes.value.map((n) => [n.id, n.x, n.y, n.width]),
]));
watch(layoutKey, () => {
  invalidateBounds();
  userTouched = false;
  nextTick(() => fitAll(false));
});

let ro = null;
onMounted(() => {
  const root = rootEl.value;
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('gesturestart', onGestureStart);
  root.addEventListener('gesturechange', onGestureChange);
  root.addEventListener('gestureend', onGestureEnd);
  window.addEventListener('keydown', onWindowKeydown);

  const measure = (w, h) => {
    const changed = w !== viewW || h !== viewH;
    viewW = w;
    viewH = h;
    if (!(w > 0 && h > 0)) return;
    if (!fitted || (changed && !userTouched)) {
      fitted = true;
      fitAll(false);
    }
  };
  const r = root.getBoundingClientRect();
  measure(r.width, r.height);
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      measure(box.width, box.height);
    });
    ro.observe(root);
  }
  if (!fitted) writeViewport();
});

onBeforeUnmount(() => {
  const root = rootEl.value;
  root?.removeEventListener('wheel', onWheel);
  root?.removeEventListener('gesturestart', onGestureStart);
  root?.removeEventListener('gesturechange', onGestureChange);
  root?.removeEventListener('gestureend', onGestureEnd);
  window.removeEventListener('keydown', onWindowKeydown);
  removeWindowListeners();
  ro?.disconnect();
  cancelAnim();
  if (rafId) cancelAnimationFrame(rafId);
  clearTimeout(wheelTimer);
  clearTimeout(flashTimer);
});

defineExpose({
  focusComment,
  fitAll: fitAllFromUser,
  frameToPage,
});
</script>

<template>
  <div
    ref="rootEl"
    class="cboard"
    :class="[`mode-${effMode}`, { gesturing, readonly }]"
    tabindex="0"
    role="region"
    aria-roledescription="畫布"
    aria-label="設計畫布：拖曳或方向鍵平移，Ctrl / ⌘ + 滾輪或 + / − 縮放，0 符合畫面"
    @pointerdown="onPointerDown"
    @keydown="onRootKeydown"
  >
    <div ref="worldEl" class="cb-world">
      <section
        v-for="f in frames"
        :key="f.id"
        class="cb-frame"
        :class="{ selected: selectedSet.has(f.id), lifted: !!headLevels[f.id] }"
        data-world-item
        :style="{
          left: `${f.x}px`,
          top: `${f.y}px`,
          width: `${f.width}px`,
          height: `${f.height}px`,
          '--fw': f.width,
          '--lv': headLevels[f.id] || 0,
        }"
        :aria-label="`設計稿：${f.title || f.id}`"
      >
        <header class="cb-fhead">
          <span class="cb-ftitle" :title="f.title || f.id">{{ f.title || f.id }}</span>
          <span class="cb-fsize">{{ f.width }}×{{ f.height }}</span>
          <button
            type="button"
            class="cb-star"
            :class="{ on: selectedSet.has(f.id) }"
            :aria-pressed="selectedSet.has(f.id)"
            :disabled="readonly"
            :title="selectedSet.has(f.id) ? '取消「選這個」' : '選這個'"
            @click="toggleSelected(f.id)"
          >
            <span aria-hidden="true">{{ selectedSet.has(f.id) ? '★' : '☆' }}</span>
            <span class="cb-star-lbl">選這個</span>
          </button>
        </header>
        <ArtifactFrame
          :ref="(el) => setFrameRef(f.id, el)"
          class="cb-fbody"
          :src="f.src"
          :frame-id="f.id"
          :title="f.title || f.id"
          :pick-mode="effMode === 'comment'"
          :pins="pinsByFrame[f.id] || NO_PINS"
          :highlight-rect="highlightByFrame[f.id] || null"
          forward-zoom
          @ready="onFrameReady"
          @pick="onFramePick"
          @pin-click="onFramePinClick"
          @pick-cancel="onFramePickCancel"
          @submit-data="onFrameSubmitData"
          @wheel="onFrameWheel"
          @pinch="onFramePinch"
          @gesture="onFrameGesture"
          @pin-move="onFramePinMove"
        />
      </section>

      <CanvasNote v-for="n in notes" :key="`n:${n.id}`" :note="n" />

      <CanvasQuestion
        v-for="q in questions"
        :key="`q:${q.id}`"
        :question="q"
        :model-value="answers[q.id]"
        :readonly="readonly"
        @answer="setAnswer"
      />

      <CanvasSticky
        v-for="s in stickies"
        :key="`s:${s.id}`"
        :ref="(el) => setStickyRef(s.id, el)"
        :sticky="s"
        :x="stickyPos(s).x"
        :y="stickyPos(s).y"
        :readonly="readonly"
        :autofocus="autofocusSticky === s.id"
        :dragging="dragPos?.id === s.id"
        @update="updateSticky"
        @remove="removeSticky"
        @blur="onStickyBlur"
      />
    </div>

    <!-- 輸入遮罩：手勢進行中蓋住所有 iframe，指標事件才不會被 frame 吃掉 -->
    <div v-show="shieldOn" class="cb-shield" aria-hidden="true" />

    <div class="cb-hint" :class="{ on: !!hint }" data-board-ui role="status">{{ hint }}</div>

    <div
      ref="toolbarEl"
      class="cb-zoom"
      data-board-ui
      role="toolbar"
      aria-label="畫布縮放"
      @keydown="onToolbarKeydown"
      @focusin="onToolbarFocusin"
    >
      <button
        type="button"
        class="cb-tool"
        :tabindex="toolIdx === 0 ? 0 : -1"
        :aria-disabled="!canZoomOut"
        aria-label="縮小"
        title="縮小（−）"
        @click="canZoomOut && zoomStep(-1)"
      >−</button>
      <span class="cb-pct" aria-hidden="true">{{ zoomPct }}%</span>
      <button
        type="button"
        class="cb-tool"
        :tabindex="toolIdx === 1 ? 0 : -1"
        :aria-disabled="!canZoomIn"
        aria-label="放大"
        title="放大（+）"
        @click="canZoomIn && zoomStep(1)"
      >+</button>
      <button
        type="button"
        class="cb-tool wide"
        :tabindex="toolIdx === 2 ? 0 : -1"
        aria-label="符合畫面"
        title="符合畫面（0）"
        @click="fitAllFromUser"
      ><span aria-hidden="true">⤢</span><span class="cb-tool-lbl">符合畫面</span></button>
      <button
        type="button"
        class="cb-tool wide"
        :tabindex="toolIdx === 3 ? 0 : -1"
        :aria-label="`縮放 100%（目前 ${zoomPct}%）`"
        title="100%"
        @click="zoomReset"
      >100%</button>
    </div>
  </div>
</template>

<style scoped>
.cboard {
  --s: 1;
  --inv: 1;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 240px;
  overflow: hidden;
  touch-action: none;
  overscroll-behavior: contain;
  outline: none;
  cursor: grab;
  background-color: var(--bg);
  background-image: radial-gradient(circle, #2b2a27 1px, transparent 1.4px);
  background-size: var(--gs, 24px) var(--gs, 24px);
  background-position: var(--gx, 0) var(--gy, 0);
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.cboard:focus-visible {
  box-shadow: inset 0 0 0 2px var(--amber-dim);
}
.cboard.gesturing {
  cursor: grabbing;
}
.cboard.mode-sticky {
  cursor: crosshair;
}
.cboard.mode-comment {
  cursor: default;
}

.cb-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
}
/* 只在拖曳時提示合成層；靜止時拿掉，縮放後文字才會重新以清晰的解析度繪製 */
.gesturing .cb-world {
  will-change: transform;
}

/* ───── frame ───── */
.cb-frame {
  position: absolute;
  background: #fff;
  box-shadow: 0 0 0 1px var(--line-bright), 0 14px 44px rgba(0, 0, 0, 0.65);
  cursor: auto;
}
.cb-frame.selected {
  /* 外框寬度除以縮放比例：不論縮放多少，螢幕上都是 3px */
  box-shadow:
    0 0 0 calc(3px * var(--inv)) var(--amber),
    0 0 calc(28px * var(--inv)) rgba(255, 184, 74, 0.35);
}
.cb-fbody {
  width: 100%;
  height: 100%;
}
.mode-sticky .cb-fbody,
.mode-sticky .cb-frame {
  cursor: crosshair;
}
/* 便利貼模式：frame 不吃事件，點在 frame 上也能貼 */
.mode-sticky .cb-fbody :deep(iframe) {
  pointer-events: none;
}

/* 標題列：反向縮放，螢幕上永遠是同樣大小；寬度 = frame 在螢幕上的寬度。
   縮得很小時（手機的符合畫面、整體縮圖）frame 可能只剩幾十 px 寬：標題列至少留 128px，標題才讀得出來；
   超出 frame 的部分可能被右邊 frame 的標題列蓋住，滑過 / 聚焦時浮到上層（完整標題也在 title 提示裡） */
.cb-fhead {
  position: absolute;
  left: 0;
  bottom: 100%;
  width: max(calc(var(--fw) * var(--s) * 1px), 128px);
  height: 30px;
  /* translateY 在 scale 之前（座標是螢幕 px）：跟右邊的標題列重疊時往上疊 --lv 層（headLevels） */
  transform: scale(var(--inv)) translateY(calc(var(--lv, 0) * -30px));
  transform-origin: 0 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 4px;
  container-type: inline-size;
  color: var(--dim);
  font-size: 12px;
  line-height: 1;
  letter-spacing: 0.04em;
  white-space: nowrap;
  cursor: grab;
}
.cb-ftitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--cjk);
  font-size: 13px;
  color: var(--bone);
}
.selected .cb-ftitle {
  color: var(--amber);
}
.cb-fsize {
  flex: none;
  color: var(--dimmer);
  font-variant-numeric: tabular-nums;
}
.cb-star {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--line-bright);
  background: var(--bg-soft);
  color: var(--dim);
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: none;
  white-space: nowrap;
}
.cb-star::before,
.cb-star::after {
  content: none;
}
.cb-star:hover {
  box-shadow: none;
}
.cb-star.on {
  border-color: var(--amber);
  background: var(--amber);
  color: #000;
}
.cb-star:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 1px;
}
.cb-star:disabled {
  opacity: 0.85;
}
.cb-star-lbl {
  font-family: var(--cjk);
}
.cb-fhead:hover,
.cb-fhead:focus-within {
  z-index: 3;
}
/* 往上疊的標題列：左邊畫一條虛線接回自己的 frame */
.lifted .cb-fhead::before {
  content: '';
  position: absolute;
  left: 0;
  top: 100%;
  height: calc(var(--lv, 0) * 30px);
  border-left: 1px dashed var(--dim);
  pointer-events: none;
}
@container (max-width: 220px) {
  .cb-fsize { display: none; }
}
/* 窄的時候星號放最前面（一定落在 frame 自己的範圍裡，不會被右邊的標題列蓋住點不到），
   標題接在後面、帶底色：跟右邊的標題列重疊時不會疊字 */
@container (max-width: 150px) {
  .cb-star-lbl { display: none; }
  .cb-star { order: -1; margin-left: 0; padding: 0 6px; }
  .cb-ftitle { padding-right: 6px; background: var(--bg); }
}

/* ───── 遮罩、提示、工具列 ───── */
.cb-shield {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: transparent;
  touch-action: none;
  cursor: inherit;
}
.cb-hint {
  position: absolute;
  top: 48px;
  left: 50%;
  z-index: 10;
  max-width: calc(100% - 24px);
  transform: translateX(-50%);
  padding: 5px 12px;
  border: 1px solid var(--amber-dim);
  background: rgba(10, 10, 10, 0.92);
  color: var(--amber);
  font-family: var(--cjk);
  font-size: 12.5px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.cb-hint.on {
  opacity: 1;
}
.cb-zoom {
  position: absolute;
  right: 12px;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line-bright);
  background: rgba(10, 10, 10, 0.94);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  cursor: default;
}
.cb-tool {
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid transparent;
  font-size: 16px;
  line-height: 1;
  letter-spacing: 0;
  color: var(--bone);
  text-transform: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.cb-tool::before,
.cb-tool::after {
  content: none;
}
.cb-tool.wide {
  font-size: 12px;
  letter-spacing: 0.06em;
}
.cb-tool:hover {
  border-color: var(--line-bright);
  box-shadow: none;
  color: var(--amber);
}
.cb-tool[aria-disabled='true'] {
  opacity: 0.35;
  cursor: not-allowed;
}
.cb-tool:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: -2px;
}
.cb-tool-lbl {
  font-family: var(--cjk);
}
.cb-pct {
  min-width: 46px;
  text-align: center;
  font-size: 12px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 600px) {
  .cb-tool-lbl { display: none; }
  .cb-pct { min-width: 40px; }
}
@media (pointer: coarse) {
  .cb-tool { min-width: 40px; height: 40px; }
}
</style>
