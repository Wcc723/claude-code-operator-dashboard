<script setup>
// 畫布上的問答卡：Claude 出的單選（radio）/ 複選（checkbox）/ 填答（textarea）。
// v-model 是這一題的答案：single → 選項字串；multi → 選項字串陣列（依選項順序）；text → 字串。
// 清空時 emit undefined，CanvasBoard 會把這題從 draft.answers 拿掉。readonly 時整張卡停用。
// 另外 emit answer(questionId, value)：CanvasBoard 用這個（handler 不必是 v-for 裡的匿名函式，
// 畫布每次縮放重新 render 時問答卡不會跟著重畫）。
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';

const props = defineProps({
  question: { type: Object, required: true },
  modelValue: { type: [String, Array], default: undefined },
  readonly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'answer']);

const TYPE_LABEL = { single: '單選', multi: '複選', text: '填答' };
const uid = useId();
const textEl = ref(null);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const type = computed(() => (['single', 'multi', 'text'].includes(props.question.type) ? props.question.type : 'text'));
const options = computed(() =>
  (Array.isArray(props.question.options) ? props.question.options : []).filter((o) => typeof o === 'string'));

const style = computed(() => ({
  left: `${num(props.question.x, 0)}px`,
  top: `${num(props.question.y, 0)}px`,
  width: `${Math.max(200, num(props.question.width, 320))}px`,
}));

const singleValue = computed(() =>
  (typeof props.modelValue === 'string' && options.value.includes(props.modelValue) ? props.modelValue : null));
const multiValue = computed(() =>
  (Array.isArray(props.modelValue) ? props.modelValue.filter((v) => options.value.includes(v)) : []));
const textValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''));

const answered = computed(() => {
  if (type.value === 'single') return singleValue.value != null;
  if (type.value === 'multi') return multiValue.value.length > 0;
  return textValue.value.trim().length > 0;
});

function send(value) {
  emit('update:modelValue', value);
  emit('answer', props.question.id, value);
}

function pickSingle(opt) {
  if (props.readonly) return;
  send(opt);
}

// 以畫面上的勾選狀態為準（不是 props）：同一個 tick 連點兩個選項時，props 還沒更新也不會掉選項
const multiEl = ref(null);
function onMultiChange() {
  if (props.readonly) return;
  const checked = new Set(
    [...(multiEl.value?.querySelectorAll('input[type="checkbox"]') ?? [])]
      .filter((el) => el.checked)
      .map((el) => Number(el.dataset.i)),
  );
  const next = options.value.filter((_, i) => checked.has(i));
  send(next.length ? next : undefined);
}

function onText(e) {
  if (props.readonly) return;
  autosize();
  const v = e.target.value;
  send(v.length ? v : undefined);
}

function clear() {
  if (props.readonly) return;
  send(undefined);
}

// 文字框跟著內容長高（畫布被縮放時拖曳 resize 把手很難用），最高 TEXT_MAX_H 之後改成捲動：
// server 自動排版時是用這個高度估問答卡的大小，長太高會蓋到下面那張卡
const TEXT_MAX_H = 200;
function autosize() {
  const el = textEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, TEXT_MAX_H)}px`;
}
onMounted(autosize);
watch(textValue, () => nextTick(autosize));
</script>

<template>
  <section class="cq" data-world-item :style="style" :class="{ answered, readonly }">
    <fieldset class="cq-set" :disabled="readonly">
      <legend class="cq-prompt">{{ question.prompt }}</legend>
      <div class="cq-meta">
        <span class="cq-type">{{ TYPE_LABEL[type] }}</span>
        <span v-if="answered" class="cq-done">已作答</span>
        <button
          v-if="answered && !readonly && type !== 'text'"
          type="button"
          class="cq-clear"
          :aria-label="`清除「${question.prompt}」的作答`"
          @click="clear"
        >清除</button>
      </div>

      <div v-if="type === 'single'" class="cq-opts" role="radiogroup" :aria-label="question.prompt">
        <label v-for="(opt, i) in options" :key="i" class="cq-opt" :class="{ on: singleValue === opt }">
          <input
            type="radio"
            :name="`cq-${uid}`"
            :value="opt"
            :checked="singleValue === opt"
            @change="pickSingle(opt)"
          />
          <span class="cq-opt-text">{{ opt }}</span>
        </label>
      </div>

      <div v-else-if="type === 'multi'" ref="multiEl" class="cq-opts" role="group" :aria-label="question.prompt">
        <label v-for="(opt, i) in options" :key="i" class="cq-opt" :class="{ on: multiValue.includes(opt) }">
          <input
            type="checkbox"
            :value="opt"
            :data-i="i"
            :checked="multiValue.includes(opt)"
            @change="onMultiChange"
          />
          <span class="cq-opt-text">{{ opt }}</span>
        </label>
      </div>

      <textarea
        v-else
        ref="textEl"
        class="cq-text"
        rows="3"
        maxlength="4000"
        placeholder="輸入回答…"
        :aria-label="question.prompt"
        :value="textValue"
        @input="onText"
      />
    </fieldset>
  </section>
</template>

<style scoped>
.cq {
  position: absolute;
  padding: 14px 16px 16px;
  background: var(--bg-soft);
  border: 1px solid var(--line-bright);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  color: var(--cream);
  font-size: 14px;
  line-height: 1.5;
}
.cq.answered {
  border-color: var(--amber-dim);
}
.cq-set {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.cq-prompt {
  display: block;
  float: left; /* 讓 legend 回到一般排版流程，不壓在 fieldset 邊框上 */
  width: 100%;
  padding: 0;
  margin: 0 0 6px;
  font-family: var(--cjk);
  font-size: 15.5px;
  font-weight: 600;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cq-meta {
  clear: both;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  margin-bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--dimmer);
}
.cq-done {
  color: var(--amber);
}
.cq-clear {
  margin-left: auto;
  padding: 0 4px;
  border: 0;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--dim);
  text-transform: none;
}
.cq-clear::before,
.cq-clear::after {
  content: none;
}
.cq-clear:hover {
  color: var(--amber);
  box-shadow: none;
}
.cq-clear:focus-visible {
  outline: 1px solid var(--amber);
}
.cq-opts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cq-opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--line-bright);
  cursor: pointer;
  font-family: var(--cjk);
  font-size: 14.5px;
  transition: border-color 80ms ease-out, background 80ms ease-out;
}
.cq-opt:hover {
  border-color: var(--amber-dim);
}
.cq-opt.on {
  border-color: var(--amber);
  background: rgba(255, 184, 74, 0.08);
}
.cq-opt:focus-within {
  outline: 1px solid var(--amber);
  outline-offset: 1px;
}
.cq-opt input {
  flex: none;
  margin: 3px 0 0;
  accent-color: var(--amber);
}
.cq-opt-text {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.readonly .cq-opt {
  cursor: default;
}
.cq-text {
  display: block;
  width: 100%;
  min-height: 72px;
  font-family: var(--cjk);
  font-size: 14.5px;
  resize: none;
  overflow-y: auto;
}
.cq-set:disabled .cq-opt,
.cq-set:disabled .cq-text {
  opacity: 0.7;
}
/* iOS 小於 16px 會在 focus 時放大整頁 */
@media (pointer: coarse) {
  .cq-text { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .cq-opt { transition: none; }
}
</style>
