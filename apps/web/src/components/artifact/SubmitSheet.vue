<script setup>
// 提交 sheet：摘要（留言 / 作答 / 選這個 / 便利貼 / 頁面資料）、「給 Claude 的話」、提交後通知 session 的勾選。
// 桌面是置中的對話框，手機是底部 sheet（都 absolute 在 ArtifactView 裡，iOS 鍵盤彈出時跟著 --app-h 縮）。
// 送出後顯示結果（已通知 / 等 session 閒置 / session 已結束、提交已保存）；409 = 這一版已經不是最新的。
// 焦點：打開時放在輸入框（看結果時放在結果訊息），Tab 在 sheet 內循環；Esc 由 ArtifactView 統一處理。
// readonly（舊版本）：只能看，「給 Claude 的話」用 readonly（不是 disabled），文字可以選取、複製。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { LIMITS, noSubmitHint, notifyResultText, payloadCounts } from '../../stores/artifact-draft.js';

const props = defineProps({
  payload: { type: Object, required: true },
  view: { type: Object, default: null },
  kind: { type: String, default: 'html' },
  origin: { type: Object, default: null },        // { terminal_id, label, alive, color }
  notify: { type: Boolean, default: true },
  readonly: { type: Boolean, default: false },    // 舊版本：只能看、不能提交
  outdated: { type: Number, default: null },      // 有更新的版本（版本號）→ 提交會 409
  busy: { type: Boolean, default: false },
  result: { type: Object, default: null },        // POST 回應 { submission, notify }
  error: { type: Object, default: null },         // { status, message }
  sheet: { type: Boolean, default: false },
});
const emit = defineEmits(['update:message', 'update:notify', 'clear-data', 'submit', 'close', 'goto-latest', 'show-history']);

const el = ref(null);
const ta = ref(null);
const headId = `ss-head-${Math.random().toString(36).slice(2, 8)}`;

const counts = computed(() => payloadCounts(props.payload, props.view));
const isCanvas = computed(() => props.kind === 'canvas');
const alive = computed(() => !!props.origin?.alive);
const originLabel = computed(() => props.origin?.label || '原本的 session');
const hasOrigin = computed(() => !!props.origin?.terminal_id || !!props.origin?.label);

const frameTitle = (id) => props.view?.frames?.find((f) => f.id === id)?.title || id;
const selectedText = computed(() => counts.value.selectedIds.map(frameTitle).join('、'));

const dataPreview = computed(() => {
  const d = props.payload?.data;
  if (d == null) return '';
  let s;
  try { s = JSON.stringify(d, null, 2); } catch { s = String(d); }
  return s.length > 1200 ? `${s.slice(0, 1200)}\n…（共 ${s.length} 字，只顯示開頭）` : s;
});

const blocked = computed(() => {
  if (props.readonly) return '這是舊版本，不能提交。切到最新版本再提交。';
  if (props.outdated) return `Claude 已經發布新版本 v${props.outdated}，這一版不能再提交。`;
  return '';
});
const canSubmit = computed(() => !props.busy && !blocked.value && !counts.value.empty);

const resultText = computed(() => (props.result ? notifyResultText(props.result.notify, { hasOrigin: hasOrigin.value }) : ''));
const resultSeq = computed(() => props.result?.submission?.seq ?? null);

function onMessage(e) {
  emit('update:message', e.target.value);
}

function submit() {
  if (canSubmit.value) emit('submit');
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !props.result) {
    e.preventDefault();
    submit();
    return;
  }
  if (e.key !== 'Tab' || !el.value) return;
  const items = [...el.value.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')]
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
  } else if (!e.shiftKey && (active === last || !el.value.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

async function focusInitial() {
  await nextTick();
  const t = props.result
    ? el.value?.querySelector('.ss-result')
    : props.error
      ? el.value?.querySelector('.ss-error')
      : ta.value;
  (t ?? el.value)?.focus({ preventScroll: true });
}

// 結果 / 錯誤出現時把焦點移過去（送出鍵在進行中被 disabled，焦點會掉回 body）
watch(() => [props.result, props.error], ([r, e]) => {
  if (r || e) focusInitial();
});

onMounted(focusInitial);
</script>

<template>
  <div class="ss-backdrop" :class="{ sheet }" @click.self="!busy && emit('close')">
    <div
      ref="el"
      class="ss"
      :class="{ sheet }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="headId"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="ss-head">
        <h3 :id="headId" class="ss-title">{{ readonly ? '這一版的回覆（唯讀）' : '提交給 CLAUDE' }}</h3>
        <button type="button" class="ss-icon" aria-label="關閉" title="關閉（Esc）" :disabled="busy" @click="emit('close')">✕</button>
      </header>

      <!-- ───── 送出之後 ───── -->
      <div v-if="result" class="ss-body">
        <p class="ss-result" role="status" tabindex="-1">
          <span class="ss-ok">✓ 提交 #{{ resultSeq ?? '—' }}</span>
          {{ resultText }}
        </p>
        <footer class="ss-actions">
          <button type="button" class="ss-btn" @click="emit('show-history')">提交紀錄</button>
          <button type="button" class="ss-btn go" @click="emit('close')">完成</button>
        </footer>
      </div>

      <!-- ───── 送出之前 ───── -->
      <form v-else class="ss-body" @submit.prevent="submit">
        <p v-if="blocked" class="ss-blocked" role="alert">
          {{ blocked }}
          <button type="button" class="ss-btn go" @click="emit('goto-latest')">切到最新版本</button>
        </p>

        <ul class="ss-sum" aria-label="這次要提交的內容">
          <li :class="{ zero: !counts.comments }">
            <span class="k">留言</span>
            <span class="v">{{ counts.comments }} 則<template v-if="counts.emptyComments">（另有 {{ counts.emptyComments }} 則空白會略過）</template></span>
          </li>
          <li v-if="isCanvas && counts.questions != null" :class="{ zero: !counts.answers }">
            <span class="k">問答</span>
            <span class="v">作答 {{ counts.answers }} / {{ counts.questions }} 題</span>
          </li>
          <li v-if="isCanvas" :class="{ zero: !counts.selected }">
            <span class="k">選這個</span>
            <span class="v">{{ counts.selected ? selectedText : '沒有' }}</span>
          </li>
          <li v-if="isCanvas" :class="{ zero: !counts.stickies }">
            <span class="k">便利貼</span>
            <span class="v">{{ counts.stickies }} 張</span>
          </li>
          <li v-if="counts.hasData">
            <span class="k">頁面資料</span>
            <span class="v">
              頁面用 window.codd.submit 送來的資料
              <button v-if="!readonly" type="button" class="ss-link" @click="emit('clear-data')">移除</button>
            </span>
          </li>
        </ul>
        <details v-if="counts.hasData" class="ss-data">
          <summary>看資料內容</summary>
          <pre>{{ dataPreview }}</pre>
        </details>

        <label class="ss-label" :for="`${headId}-msg`">給 Claude 的話（選填）</label>
        <textarea
          :id="`${headId}-msg`"
          ref="ta"
          class="ss-ta"
          rows="4"
          :value="payload.message"
          :maxlength="LIMITS.message"
          :readonly="readonly"
          :disabled="busy"
          :placeholder="readonly ? '（這一版沒有寫）' : '整體感覺、要改的方向、下一步想看什麼…'"
          @input="onMessage"
        />

        <div v-if="hasOrigin" class="ss-notify" :class="{ off: !alive }">
          <label class="ss-check">
            <input
              type="checkbox"
              :checked="alive && notify"
              :disabled="!alive || readonly"
              @change="emit('update:notify', $event.target.checked)"
            />
            <span>提交後通知 session（<span class="ss-origin">{{ originLabel }}</span>）</span>
          </label>
          <p class="ss-help">
            <template v-if="alive">會在那個 session 輸入一行 [CODD] 通知，請 Claude 讀取這次的提交；session 忙的話等它閒置再送。</template>
            <template v-else>原本的 session 已經結束，沒辦法通知。提交仍會保存，之後在任何 session 請 Claude 用 artifact_read_submissions 讀取。</template>
          </p>
        </div>
        <p v-else class="ss-help">這個 artifact 不是從 CODD 的 session 建立的，提交會保存，請 Claude 用 artifact_read_submissions 讀取。</p>

        <p v-if="error" class="ss-error" role="alert" tabindex="-1">
          {{ error.message }}
          <button v-if="error.status === 409" type="button" class="ss-btn go" @click="emit('goto-latest')">切到最新版本</button>
        </p>
        <p v-else-if="counts.empty && !blocked" class="ss-help">還沒有任何內容：留言、作答、選一個 frame，或寫幾句給 Claude 的話。</p>
        <p v-if="!readonly" class="ss-help">{{ noSubmitHint(origin) }}</p>

        <footer class="ss-actions">
          <template v-if="readonly">
            <button type="button" class="ss-btn go" @click="emit('close')">關閉</button>
          </template>
          <template v-else>
            <span class="ss-hint">⌘/Ctrl + Enter 提交</span>
            <button type="button" class="ss-btn" :disabled="busy" @click="emit('close')">取消</button>
            <button type="submit" class="ss-btn primary" :disabled="!canSubmit">{{ busy ? '提交中…' : '提交' }}</button>
          </template>
        </footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.ss-backdrop {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(1px);
  animation: ss-fade 140ms ease-out;
}
.ss-backdrop.sheet {
  align-items: flex-end;
  padding: 0;
}

.ss {
  width: min(520px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 0 60px rgba(255, 176, 0, 0.12), 0 20px 50px rgba(0, 0, 0, 0.8);
  font-size: 14px;
  line-height: 1.5;
  color: var(--bone);
  outline: none;
  animation: ss-in 160ms ease-out;
}
.ss.sheet {
  width: 100%;
  max-height: 92%;
  border-left: none;
  border-right: none;
  border-bottom: none;
  animation: ss-up 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ss-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 16px;
  border-bottom: 1px dashed var(--line-bright);
}
.ss-title {
  flex: 1;
  margin: 0;
  font-family: var(--display);
  font-size: 14px;
  letter-spacing: 0.16em;
  color: var(--amber);
}
.ss-icon {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  font-size: 14px;
  letter-spacing: 0;
  color: var(--dim);
}
.ss-icon::before,
.ss-icon::after { content: none; }
.ss-icon:hover { color: var(--amber); box-shadow: none; }

.ss-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ss.sheet .ss-body {
  padding-bottom: calc(14px + env(safe-area-inset-bottom));
}

.ss-sum {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.ss-sum li {
  display: flex;
  gap: 10px;
  min-width: 0;
}
.ss-sum .k {
  flex: none;
  width: 5.5em;
  color: var(--dim);
}
.ss-sum .v {
  flex: 1;
  min-width: 0;
  color: var(--cream);
  overflow-wrap: anywhere;
}
.ss-sum li.zero .v { color: var(--dimmer); }

.ss-data {
  font-size: 12px;
  color: var(--dim);
}
.ss-data summary { cursor: pointer; }
.ss-data pre {
  margin: 6px 0 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  background: #000;
  border: 1px solid var(--line-bright);
  color: var(--bone);
  white-space: pre-wrap;
  word-break: break-all;
}

.ss-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--dim);
  margin-bottom: -6px;
}
.ss-ta {
  width: 100%;
  min-height: 92px;
  font-size: 14px;
}

.ss-notify {
  padding: 8px 10px;
  border: 1px dashed var(--line-bright);
}
.ss-notify.off { border-color: var(--line); }
.ss-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  color: var(--cream);
  font-size: 13.5px;
}
.ss-notify.off .ss-check { color: var(--dim); cursor: not-allowed; }
.ss-check input { margin-top: 4px; flex: none; }
.ss-origin { color: var(--amber); overflow-wrap: anywhere; }
.ss-notify.off .ss-origin { color: var(--dim); }
.ss-help {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dimmer);
}
.ss-blocked,
.ss-error {
  margin: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  outline: none;
}
.ss-blocked { color: var(--amber); }
.ss-error { color: var(--danger); }

.ss-result {
  margin: 0;
  font-size: 14px;
  color: var(--cream);
  outline: none;
}
.ss-ok {
  display: block;
  margin-bottom: 4px;
  color: var(--success);
  letter-spacing: 0.08em;
}

.ss-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.ss-hint {
  flex: 1;
  font-size: 11px;
  color: var(--dimmer);
}

.ss-btn {
  padding: 4px 12px;
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: none;
  white-space: nowrap;
}
.ss-btn.go {
  color: var(--amber);
  border-color: var(--amber-dim);
}
.ss-btn.go:hover { background: var(--amber); color: #000; }
.ss-btn.go:hover::before,
.ss-btn.go:hover::after { color: #000; }
.ss-link {
  border: none;
  padding: 0 4px;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: none;
  color: var(--dim);
  text-decoration: underline dashed;
}
.ss-link::before,
.ss-link::after { content: none; }
.ss-link:hover { color: var(--danger); box-shadow: none; }

.ss :is(button, textarea, input, summary):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .ss-icon { width: 40px; height: 40px; }
  .ss-btn { min-height: 40px; padding: 0 16px; }
  .ss-link { min-height: 32px; }
  .ss-ta { font-size: 16px; }
  .ss-check input { width: 20px; height: 20px; margin-top: 1px; }
  .ss-hint { display: none; }
}

@keyframes ss-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ss-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes ss-up {
  from { transform: translateY(100%); }
  to { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ss-backdrop, .ss, .ss.sheet { animation: none; }
}
</style>
