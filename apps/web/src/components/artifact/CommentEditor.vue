<script setup>
// 釘選留言的編輯浮層。桌面：浮在點擊位置旁邊（anchor = viewport 座標，換算成 offsetParent 內的座標並夾在範圍內）；
// 手機（sheet）：貼在畫面底部的 sheet。文字直接改草稿裡那則留言（emit update:text），
// 關掉時由 ArtifactView 決定要不要移除空白留言（規格：editor 關閉時文字仍是空的就移除）。
// Esc 由 ArtifactView 的全域 keydown 統一處理（一次 Esc 只退一層）；這裡的 keydown 只是保險。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LIMITS, targetLabel } from '../../stores/artifact-draft.js';

const props = defineProps({
  comment: { type: Object, required: true },
  n: { type: Number, default: null },          // 釘選編號
  frameTitle: { type: String, default: '' },
  anchor: { type: Object, default: null },     // { pageX, pageY }（viewport 座標）
  sheet: { type: Boolean, default: false },    // 手機：底部 sheet
  readonly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:text', 'close', 'delete']);

const el = ref(null);
const ta = ref(null);
const pos = ref(null);
const headId = `ce-head-${Math.random().toString(36).slice(2, 8)}`;

const target = computed(() => targetLabel(props.comment?.target, { maxText: 60 }));
const text = computed(() => props.comment?.text ?? '');
const tooLong = computed(() => text.value.length > LIMITS.commentText);

// ───── 位置 ─────
const GAP = 14;
const MARGIN = 8;

function place() {
  if (props.sheet || !el.value) {
    pos.value = null;
    return;
  }
  const parent = el.value.offsetParent ?? document.body;
  const pr = parent.getBoundingClientRect();
  const w = el.value.offsetWidth;
  const h = el.value.offsetHeight;
  const maxLeft = Math.max(MARGIN, pr.width - w - MARGIN);
  const maxTop = Math.max(MARGIN, pr.height - h - MARGIN);
  const ax = Number.isFinite(props.anchor?.pageX) ? props.anchor.pageX - pr.left : pr.width / 2 - w / 2;
  const ay = Number.isFinite(props.anchor?.pageY) ? props.anchor.pageY - pr.top : pr.height / 3;
  // 預設放在點擊位置右下；超出右緣 / 下緣就翻到另一邊
  let left = ax + GAP;
  if (left + w > pr.width - MARGIN) left = ax - GAP - w;
  let top = ay + GAP;
  if (top + h > pr.height - MARGIN) top = ay - GAP - h;
  pos.value = {
    left: `${Math.round(Math.min(maxLeft, Math.max(MARGIN, left)))}px`,
    top: `${Math.round(Math.min(maxTop, Math.max(MARGIN, top)))}px`,
  };
}

let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); });
}

watch(() => [props.anchor?.pageX, props.anchor?.pageY, props.sheet], () => nextTick(place));

// ───── 輸入 ─────
function onInput(e) {
  emit('update:text', e.target.value);
  autosize();
}

function autosize() {
  const t = ta.value;
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, props.sheet ? 180 : 240)}px`;
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close', 'escape');
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    emit('close', 'done');
  }
}

// 點浮層外面 = 完成（iframe 裡的點擊不會傳到這裡，那是 ArtifactView 透過 pick 事件處理）
function onDocPointer(e) {
  if (el.value?.contains(e.target)) return;
  emit('close', 'outside');
}

onMounted(async () => {
  await nextTick();
  place();
  autosize();
  // 量好位置之前是 visibility:hidden（focus 不上去）：等位置套用到 DOM 再 focus
  await nextTick();
  if (props.readonly) el.value?.focus({ preventScroll: true });
  else ta.value?.focus({ preventScroll: true });
  // 晚一個 frame 才開始聽：打開它的那次點擊（例如留言清單的按鈕）不要馬上把它關掉
  requestAnimationFrame(() => document.addEventListener('pointerdown', onDocPointer, true));
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  document.removeEventListener('pointerdown', onDocPointer, true);
  window.removeEventListener('resize', schedule);
  window.visualViewport?.removeEventListener('resize', schedule);
});

defineExpose({ place, focus: () => ta.value?.focus() });
</script>

<template>
  <div
    ref="el"
    class="ce"
    :class="{ sheet, readonly }"
    :style="sheet ? null : (pos ?? { visibility: 'hidden' })"
    role="dialog"
    aria-modal="false"
    :aria-labelledby="headId"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <header class="ce-head">
      <span :id="headId" class="ce-title">
        <span v-if="n != null" class="ce-n">#{{ n }}</span>
        <span class="ce-frame">{{ frameTitle || '留言' }}</span>
      </span>
      <button type="button" class="ce-icon" aria-label="關閉留言" title="關閉（Esc）" @click="emit('close', 'done')">✕</button>
    </header>

    <p v-if="target" class="ce-target" :title="comment.target?.selector || ''">{{ target }}</p>

    <template v-if="readonly">
      <p class="ce-text">{{ text || '（沒有內容）' }}</p>
    </template>
    <template v-else>
      <label class="sr-only" :for="`${headId}-ta`">留言內容</label>
      <textarea
        :id="`${headId}-ta`"
        ref="ta"
        class="ce-ta"
        rows="3"
        :value="text"
        :maxlength="LIMITS.commentText"
        placeholder="這裡想怎麼改？"
        @input="onInput"
      />
      <p v-if="tooLong" class="ce-warn">超過 {{ LIMITS.commentText }} 字，提交時會被截斷</p>
      <footer class="ce-foot">
        <span class="ce-hint">⌘/Ctrl + Enter 完成</span>
        <button type="button" class="ce-btn danger" @click="emit('delete')">刪除</button>
        <button type="button" class="ce-btn go" @click="emit('close', 'done')">完成</button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.ce {
  position: absolute;
  z-index: 60;
  width: min(340px, calc(100% - 16px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  background: var(--bg-soft);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.75), 0 0 24px rgba(255, 176, 0, 0.08);
  font-size: 13px;
  line-height: 1.45;
  color: var(--bone);
  outline: none;
  animation: ce-in 120ms ease-out;
}
.ce.sheet {
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
  border-left: none;
  border-right: none;
  border-bottom: none;
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.8);
  animation: ce-up 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ce-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ce-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  letter-spacing: 0.08em;
}
.ce-n {
  flex: none;
  color: #000;
  background: var(--amber);
  padding: 0 6px;
  font-weight: 700;
  letter-spacing: 0;
}
.ce-frame {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dim);
}
.ce-target {
  margin: 0;
  font-size: 12px;
  color: var(--amber-dim);
  overflow-wrap: anywhere;
}
.ce-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--cream);
  max-height: 40vh;
  overflow: auto;
}
.ce-ta {
  width: 100%;
  min-height: 64px;
  font-size: 14px;
  resize: none;
}
.ce-warn {
  margin: 0;
  font-size: 11.5px;
  color: var(--danger);
}
.ce-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ce-hint {
  flex: 1;
  font-size: 11px;
  color: var(--dimmer);
}

.ce-icon {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  font-size: 14px;
  letter-spacing: 0;
  color: var(--dim);
}
.ce-icon::before,
.ce-icon::after { content: none; }
.ce-icon:hover { color: var(--amber); box-shadow: none; }

.ce-btn {
  padding: 2px 8px;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: none;
}
.ce-btn.go {
  color: var(--amber);
  border-color: var(--amber-dim);
}
.ce-btn.go:hover { background: var(--amber); color: #000; }
.ce-btn.go:hover::before,
.ce-btn.go:hover::after { color: #000; }
.ce-btn.danger { color: var(--dim); border-color: var(--line-bright); }
.ce-btn.danger::before,
.ce-btn.danger::after { color: var(--dim); }
.ce-btn.danger:hover { color: var(--danger); border-color: var(--danger); background: transparent; box-shadow: none; }

.ce :is(button, textarea):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (pointer: coarse) {
  .ce-icon { width: 40px; height: 40px; }
  .ce-btn { min-height: 40px; padding: 0 14px; font-size: 13px; }
  .ce-ta { font-size: 16px; } /* iOS 小於 16px 會在 focus 時放大整頁 */
  .ce-hint { display: none; }
  .ce-foot { justify-content: flex-end; }
}

@keyframes ce-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@keyframes ce-up {
  from { transform: translateY(100%); }
  to { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ce, .ce.sheet { animation: none; }
}
</style>
