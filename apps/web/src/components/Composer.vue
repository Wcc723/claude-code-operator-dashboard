<script>
import { reactive } from 'vue';

// 每個 session 各自的草稿（module 層：切 session、離開頁面再回來都還在），
// 也避免把 A 的半句話送進 B
const drafts = new Map();
// 送出中的 session：送到一半切到別的 session，B 不該被 A 的 sending 擋住
const inflight = reactive(new Set());
</script>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';

const props = defineProps({
  sessionId: { type: String, required: true },
  // async (text) => void；成功才清空輸入框
  send: { type: Function, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['interact']);

const MAX_HEIGHT_PX = 150;
// 手機寬度放不下長提示（換行會把輸入框撐成兩行）；軟鍵盤也沒有 Shift+Enter
const placeholder = window.matchMedia?.('(pointer: coarse)').matches
  ? '輸入訊息…'
  : '訊息 · Enter 送出 · ⇧Enter 換行';

const text = ref(drafts.get(props.sessionId) ?? '');
const sending = computed(() => inflight.has(props.sessionId));
const error = ref('');
const box = ref(null);
// 注音 / 拼音選字中：Enter 是「確認選字」不是送出
let composing = false;

function autosize() {
  const el = box.value;
  if (!el) return;
  // 上限以 CSS max-height 為準（手機版較矮）
  const max = parseFloat(getComputedStyle(el).maxHeight) || MAX_HEIGHT_PX;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  // 還沒到上限前不顯示捲軸（有些瀏覽器會因為小數像素多出一條空捲軸）
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}

async function submit() {
  if (sending.value || props.disabled) return;
  const value = text.value;
  const id = props.sessionId;
  inflight.add(id);
  error.value = '';
  emit('interact');
  try {
    await props.send(value);
    // 送出途中切到別的 session：已送出的內容不能留成 A 的草稿，回到 A 再按 Enter 會送第二次
    if (drafts.get(id) === value) drafts.delete(id);
    if (props.sessionId === id && text.value === value) {
      text.value = '';
      await nextTick();
      autosize();
    }
  } catch (e) {
    if (props.sessionId === id) error.value = e?.message || 'send failed';
  } finally {
    inflight.delete(id);
  }
}

function onCompositionStart() { composing = true; }
function onCompositionEnd() { composing = false; }

function onKeydown(e) {
  if (e.key !== 'Enter') return;
  // Safari 的 compositionend 會比確認選字的 keydown 早到，isComposing 已是 false，只剩 keyCode 229 可判斷
  if (e.isComposing || e.keyCode === 229 || composing) return;
  if (e.shiftKey || e.altKey) return; // Shift+Enter 換行
  e.preventDefault();
  submit();
}

watch(text, (v) => {
  if (v) drafts.set(props.sessionId, v);
  else drafts.delete(props.sessionId);
  nextTick(autosize);
});

watch(() => props.sessionId, (id) => {
  text.value = drafts.get(id) ?? '';
  error.value = '';
});

onMounted(autosize);

defineExpose({ focus: () => box.value?.focus() });
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <textarea
      ref="box"
      v-model="text"
      class="input"
      name="message"
      rows="1"
      enterkeyhint="send"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      :disabled="disabled"
      :placeholder="placeholder"
      aria-label="輸入給 session 的文字"
      @keydown="onKeydown"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
      @focus="emit('interact')"
    />
    <button
      type="submit"
      class="send"
      :disabled="disabled || sending"
      title="送出（空白時送出 Enter）"
      @pointerdown.prevent
      @mousedown.prevent
    >{{ sending ? '…' : 'SEND' }}</button>
    <p v-if="error" class="err">{{ error }}</p>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
  background: var(--bg-soft);
  border-top: 1px solid var(--line);
}
.input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  max-height: 150px;
  /* ≥ 16px：iOS 才不會在 focus 時自動放大頁面 */
  font-size: max(16px, 1rem);
  line-height: 1.45;
  font-family: var(--mono), var(--cjk);
  padding: 10px 12px;
  resize: none;
  overflow-y: auto;
  background: var(--bg);
}
.send {
  flex: 0 0 auto;
  min-height: 44px;
  min-width: 72px;
  padding: 0 14px;
  font-size: 14px;
  color: var(--amber);
  border-color: var(--amber-dim);
  touch-action: manipulation;
}
.send::before,
.send::after { content: none; }
.send:hover {
  background: var(--amber);
  color: #000;
}
.err {
  flex-basis: 100%;
  margin: 0;
  font-size: 13px;
  color: var(--danger);
}
.input::placeholder {
  color: var(--dimmer);
}

@media (max-width: 767px) {
  .input { max-height: 120px; }
}
</style>
