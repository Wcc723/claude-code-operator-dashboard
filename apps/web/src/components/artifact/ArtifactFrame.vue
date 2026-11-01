<script setup>
// 單一 artifact frame：sandbox iframe + parent 端 bridge（lib/artifact-bridge.js）。
// html kind 的 ArtifactView 全畫面用它；canvas 的 CanvasBoard 每個 frame 用一個。
//
// 安全：sandbox 只給 allow-scripts allow-forms allow-popups allow-modals。
// 絕對不能加 allow-same-origin（artifact 會拿到 CODD 的 cookie 與 API）或 allow-top-navigation。
//
// pick / pin-click 事件除了 bridge 給的欄位，另外附上 pageX / pageY（viewport 座標）：
// iframe 可能被畫布 transform 縮放，所以 = iframe 的 getBoundingClientRect() + clientX × 縮放比。
// 另有選用的 wheel 事件（bridge 轉送 frame 裡的 Ctrl/⌘ + 滾輪，見 artifact-bridge.js），一樣附 pageX / pageY；
// pinch（兩指觸控，points 每一點都換成 pageX / pageY）、gesture（Safari 觸控板 pinch）也是 forwardZoom 才有。
// pin-move：作用中的釘選圓點因為 frame 捲動換了位置（附 pageX / pageY），留言編輯框跟著走。
// highlightRect 可以帶 selector（留言的 target.selector）：內層容器捲動的頁面也畫得到對的位置。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { attachFrame } from '../../lib/artifact-bridge.js';

const props = defineProps({
  src: { type: String, required: true },
  frameId: { type: String, required: true },
  pickMode: { type: Boolean, default: false },
  pins: { type: Array, default: () => [] },
  highlightRect: { type: Object, default: null },
  title: { type: String, default: '' },
  // canvas 用：frame 裡的 Ctrl + 滾輪（觸控板 pinch）轉成 wheel 事件給畫布縮放，而不是讓瀏覽器縮放整頁
  forwardZoom: { type: Boolean, default: false },
});
const emit = defineEmits(['ready', 'pick', 'pin-click', 'submit-data', 'pick-cancel', 'wheel', 'pinch', 'gesture', 'pin-move']);

const iframeEl = ref(null);
const loading = ref(true);
let bridge = null;

/** iframe 內的 client 座標 → 外層 viewport 座標 */
function toViewport(clientX, clientY) {
  const el = iframeEl.value;
  if (!el) return { pageX: clientX, pageY: clientY };
  const rect = el.getBoundingClientRect();
  const sx = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
  const sy = el.offsetHeight > 0 ? rect.height / el.offsetHeight : sx;
  return { pageX: rect.left + clientX * sx, pageY: rect.top + clientY * sy };
}

function attach() {
  bridge?.detach();
  bridge = null;
  const el = iframeEl.value;
  if (!el) return;
  bridge = attachFrame(el, {
    frameId: props.frameId,
    forwardZoom: props.forwardZoom,
    onReady(info) {
      loading.value = false;
      emit('ready', info);
    },
    onPick(info) {
      emit('pick', { ...info, ...toViewport(info.clientX, info.clientY) });
    },
    onPinClick(info) {
      emit('pin-click', { ...info, ...toViewport(info.clientX, info.clientY) });
    },
    onSubmitData(info) {
      emit('submit-data', info);
    },
    onPickCancel(info) {
      emit('pick-cancel', info);
    },
    onWheel(info) {
      emit('wheel', { ...info, ...toViewport(info.clientX, info.clientY) });
    },
    onPinch(info) {
      emit('pinch', { ...info, points: info.points.map((p) => toViewport(p.clientX, p.clientY)) });
    },
    onGesture(info) {
      emit('gesture', { ...info, ...toViewport(info.clientX, info.clientY) });
    },
    onPinPos(info) {
      emit('pin-move', { ...info, ...toViewport(info.clientX, info.clientY) });
    },
  });
  bridge.setPickMode(props.pickMode);
  bridge.setPins(props.pins);
  bridge.highlight(props.highlightRect);
}

onMounted(attach);
onBeforeUnmount(() => {
  bridge?.detach();
  bridge = null;
});

// frameId 或 src 換了就重新掛：bridge 用 frameId 過濾訊息，而且新文件 ready 之前呼叫的 scrollTo 要排隊等它
watch(() => props.frameId, attach);
watch(() => props.src, () => {
  loading.value = true;
  attach();
});
watch(() => props.pickMode, (on) => bridge?.setPickMode(on));
watch(() => props.forwardZoom, (on) => bridge?.setForwardZoom(on));
watch(() => props.pins, (pins) => bridge?.setPins(pins), { deep: true });
watch(() => props.highlightRect, (rect) => bridge?.highlight(rect), { deep: true });

// 沒有 bridge 的頁面（或 bridge 壞掉）不會送 ready，load 之後也要把「載入中」拿掉
function onLoad() {
  loading.value = false;
}

defineExpose({
  scrollTo(x, y, selector) {
    bridge?.scrollTo(x, y, selector);
  },
  getClientRect() {
    return iframeEl.value?.getBoundingClientRect() ?? null;
  },
  /** frame 裡的 client 座標 → 外層 viewport 座標 { pageX, pageY }（用 iframe 現在的位置與縮放） */
  toViewport,
});
</script>

<template>
  <div class="aframe" :class="{ picking: pickMode }">
    <iframe
      ref="iframeEl"
      class="aframe-el"
      :src="src"
      :title="title || frameId"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      referrerpolicy="no-referrer"
      loading="lazy"
      @load="onLoad"
    />
    <div v-if="loading" class="aframe-loading" aria-hidden="true">載入中…</div>
  </div>
</template>

<style scoped>
.aframe {
  position: relative;
  width: 100%;
  height: 100%;
  background: #fff;
  overflow: hidden;
}
.aframe-el {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.aframe-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-soft);
  color: var(--dimmer);
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.12em;
  pointer-events: none;
}
</style>
