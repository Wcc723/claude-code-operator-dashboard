<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import * as pool from '../composables/terminalPool.js';

const props = defineProps({
  sessionId: { type: String, required: true },
  clientId: { type: String, required: true },
  exited: { type: Boolean, default: false },
});
const emit = defineEmits(['state']);

const RESIZE_DEBOUNCE_MS = 150;

const viewport = ref(null);
const state = shallowRef(null);
let currentId = null;
let ro = null;
let roTimer = null;

function mount(id) {
  const el = viewport.value;
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
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  clearTimeout(roTimer);
  roTimer = null;
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
  const el = viewport.value;
  const y = currentId ? pool.cursorBottomPx(currentId) : null;
  if (!el || y == null) return;
  el.scrollTop = Math.max(0, y + 24 - el.clientHeight);
  el.scrollLeft = 0;
});

defineExpose({
  claim: () => currentId && pool.claim(currentId),
  focus: () => currentId && pool.focus(currentId),
});
</script>

<template>
  <div class="pane">
    <div ref="viewport" class="viewport" :class="{ following: state?.follow }" />
    <button
      v-if="showHint"
      type="button"
      class="hint"
      @click="takeControl"
    >◇ 跟隨其他裝置的尺寸 {{ state.ptySize?.cols }}×{{ state.ptySize?.rows }} · 點此接管</button>
    <span v-if="streamLabel" class="stream">{{ streamLabel }}</span>
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

.stream {
  position: absolute;
  bottom: 8px;
  right: 18px;
  z-index: 3;
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
