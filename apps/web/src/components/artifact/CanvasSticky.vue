<script setup>
// 使用者的便利貼（draft.stickies 的一張）。
// 拖曳由 CanvasBoard 統一處理（它知道縮放比例、會蓋輸入遮罩）：根元素帶 data-sticky-id，
// 在文字框與按鈕以外的地方按下就算拖曳的起點（超過 4px 才真的開始拖）。
// 鍵盤：把手（⠿）可 Tab 到，方向鍵移動 10px（Shift ×5）；Delete / Backspace 刪除。
// 事件都帶便利貼 id：update(id, patch)、remove(id)、focus(id)、blur(id)。
// 顏色與刪除按鈕在 mousedown 時 preventDefault：點它們不會把焦點從文字框拿走。Safari 點按鈕不會 focus 按鈕，
// 焦點會掉到 body，CanvasBoard 就把剛貼、還空白的便利貼當成「離開了」收掉；保留焦點也讓人選完顏色能接著打字。
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps({
  sticky: { type: Object, required: true },
  /** 顯示位置（世界座標）；拖曳中由 CanvasBoard 傳暫時位置 */
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
  autofocus: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
});
const emit = defineEmits(['update', 'remove', 'focus', 'blur']);

const COLORS = [
  { key: 'yellow', label: '黃', hex: '#f2d64b' },
  { key: 'pink', label: '粉', hex: '#ff9fd6' },
  { key: 'blue', label: '藍', hex: '#8cc4ff' },
  { key: 'green', label: '綠', hex: '#8fe3ac' },
  { key: 'purple', label: '紫', hex: '#cdb4ff' },
  { key: 'gray', label: '灰', hex: '#cfc9bc' },
];
const MOVE_STEP = 10;

const textEl = ref(null);
const colorKey = computed(() => (COLORS.some((c) => c.key === props.sticky.color) ? props.sticky.color : 'yellow'));
const hex = computed(() => COLORS.find((c) => c.key === colorKey.value).hex);
const text = computed(() => (typeof props.sticky.text === 'string' ? props.sticky.text : ''));

const style = computed(() => ({ left: `${props.x}px`, top: `${props.y}px`, '--c': hex.value }));

function autosize() {
  const el = textEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 360)}px`;
}

function onInput(e) {
  autosize();
  emit('update', props.sticky.id, { text: e.target.value });
}

function setColor(key) {
  if (props.readonly || key === colorKey.value) return;
  emit('update', props.sticky.id, { color: key });
}

function onColorKey(e) {
  const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!delta) return;
  e.preventDefault();
  const group = e.currentTarget;
  const i = COLORS.findIndex((c) => c.key === colorKey.value);
  const next = COLORS[(i + delta + COLORS.length) % COLORS.length];
  setColor(next.key);
  nextTick(() => group?.querySelector?.(`[data-color="${next.key}"]`)?.focus());
}

function onGripKey(e) {
  if (props.readonly) return;
  const step = e.shiftKey ? MOVE_STEP * 5 : MOVE_STEP;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    emit('update', props.sticky.id, { x: Math.round(props.x + d[0]), y: Math.round(props.y + d[1]) });
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    emit('remove', props.sticky.id);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    focusText();
  }
}

function focusText() {
  const el = textEl.value;
  if (!el) return;
  el.focus({ preventScroll: true });
  const n = el.value.length;
  try {
    el.setSelectionRange(n, n);
  } catch {
    /* readonly 時某些瀏覽器會丟例外 */
  }
}

onMounted(() => {
  autosize();
  if (props.autofocus && !props.readonly) focusText();
});
watch(text, () => nextTick(autosize));
watch(() => props.autofocus, (on) => {
  if (on && !props.readonly) nextTick(focusText);
});

defineExpose({ focusText });
</script>

<template>
  <div
    class="csticky"
    :class="{ dragging, readonly }"
    data-world-item
    :data-sticky-id="sticky.id"
    :style="style"
    role="group"
    aria-label="便利貼"
  >
    <div class="cs-head">
      <div
        v-if="!readonly"
        class="cs-grip"
        role="button"
        tabindex="0"
        aria-label="移動便利貼：拖曳或用方向鍵"
        title="拖曳移動（方向鍵也可以）"
        @keydown="onGripKey"
      >⠿</div>
      <div
        v-if="!readonly"
        class="cs-colors"
        role="radiogroup"
        aria-label="便利貼顏色"
        @keydown="onColorKey"
      >
        <button
          v-for="c in COLORS"
          :key="c.key"
          type="button"
          class="cs-sw"
          :class="{ on: c.key === colorKey }"
          role="radio"
          :data-color="c.key"
          :aria-checked="c.key === colorKey"
          :aria-label="`${c.label}色`"
          :title="`${c.label}色`"
          :tabindex="c.key === colorKey ? 0 : -1"
          :style="{ '--sw': c.hex }"
          @mousedown.prevent
          @click="setColor(c.key)"
        />
      </div>
      <button
        v-if="!readonly"
        type="button"
        class="cs-del"
        aria-label="刪除便利貼"
        title="刪除"
        @mousedown.prevent
        @click="emit('remove', sticky.id)"
      >✕</button>
    </div>
    <textarea
      ref="textEl"
      class="cs-text"
      rows="3"
      maxlength="2000"
      placeholder="寫點什麼…"
      aria-label="便利貼內容"
      :readonly="readonly"
      :value="text"
      @input="onInput"
      @focus="emit('focus', sticky.id)"
      @blur="emit('blur', sticky.id)"
    />
  </div>
</template>

<style scoped>
.csticky {
  position: absolute;
  width: 210px;
  background: var(--c);
  color: #1b1a17;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55), 0 1px 0 rgba(255, 255, 255, 0.25) inset;
  transform: rotate(-0.6deg);
  transition: box-shadow 120ms ease-out, transform 120ms ease-out;
  cursor: grab;
}
.csticky.readonly {
  cursor: default;
}
.csticky:focus-within {
  transform: none;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6), 0 0 0 2px var(--amber);
}
.csticky.dragging {
  cursor: grabbing;
  transform: rotate(1.2deg) scale(1.02);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.7);
  transition: none;
}
.cs-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 3px 4px 0 6px;
}
.cs-grip {
  flex: none;
  width: 22px;
  line-height: 22px;
  text-align: center;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.45);
  user-select: none;
}
.cs-grip:focus-visible {
  outline: 2px solid #1b1a17;
  outline-offset: 1px;
}
.cs-colors {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.csticky:hover .cs-colors,
.csticky:focus-within .cs-colors {
  opacity: 1;
}
.cs-sw {
  --sw: #fff;
  width: 13px;
  height: 13px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.35);
  border-radius: 50%;
  background: var(--sw);
  box-shadow: none;
}
.cs-sw::before,
.cs-sw::after,
.cs-del::before,
.cs-del::after {
  content: none;
}
.cs-sw:hover {
  box-shadow: none;
  border-color: #000;
}
.cs-sw.on {
  outline: 2px solid rgba(0, 0, 0, 0.7);
  outline-offset: 1px;
}
.cs-sw:focus-visible {
  outline: 2px solid #000;
  outline-offset: 2px;
}
.cs-del {
  margin-left: auto;
  width: 24px;
  height: 22px;
  padding: 0;
  border: 0;
  font-size: 12px;
  line-height: 1;
  letter-spacing: 0;
  color: rgba(0, 0, 0, 0.5);
}
.cs-del:hover {
  color: #000;
  box-shadow: none;
}
.cs-del:focus-visible {
  outline: 2px solid #1b1a17;
}
.cs-text {
  display: block;
  width: 100%;
  min-height: 64px;
  padding: 4px 12px 12px;
  border: 0;
  background: transparent;
  color: #1b1a17;
  caret-color: #1b1a17;
  font-family: var(--cjk);
  font-size: 15px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}
.cs-text::placeholder {
  color: rgba(0, 0, 0, 0.4);
}
.cs-text:focus {
  border: 0;
  box-shadow: none;
}
@media (pointer: coarse) {
  /* iOS 小於 16px 會在 focus 時放大整頁 */
  .cs-text { font-size: 16px; }
  .cs-colors { opacity: 1; }
  .cs-sw { width: 18px; height: 18px; }
  .cs-del { width: 30px; height: 28px; }
  .cs-grip { width: 28px; line-height: 28px; }
}
@media (prefers-reduced-motion: reduce) {
  .csticky,
  .cs-colors { transition: none; }
}
</style>
