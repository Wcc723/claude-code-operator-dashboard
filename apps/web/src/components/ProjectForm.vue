<script setup>
// PROJECTS 頁的新增 / 編輯表單（新增時放在列表上方，編輯時直接取代那張卡片）。
// env 改成一行一個 KEY=VALUE（舊版是 JSON，手機上很難打）；貼 JSON 物件進來也照樣吃。
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import ColorPicker from './ColorPicker.vue';

const props = defineProps({
  // { name, cwd, command, env, color }
  initial: { type: Object, default: () => ({}) },
  mode: { type: String, default: 'new' }, // 'new' | 'edit'
  busy: { type: Boolean, default: false },
  error: { type: String, default: null },
});
const emit = defineEmits(['submit', 'cancel']);

const uid = useId();
const fid = (k) => `${uid}-${k}`;

// 跟 server（terminal-manager 的 sanitizeProfileEnv）同一份規則：這些 key 不會傳給 session
// （要放在 envText 初始化之前：envToText 會用到 parseEnv → KEY_RE）
const BLOCKED_EXACT = new Set(['PATH', 'NODE_PATH']);
const BLOCKED_PREFIX = ['LD_', 'DYLD_', 'NODE_OPTIONS'];
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const name = ref(props.initial.name ?? '');
const cwd = ref(props.initial.cwd ?? '');
const command = ref(props.initial.command ?? '');
const color = ref(props.initial.color ?? null);
const envText = ref(envToText(props.initial.env));
const localError = ref(null);
const nameInput = ref(null);

function envToText(env) {
  const entries = Object.entries(env && typeof env === 'object' ? env : {});
  if (!entries.length) return '';
  // 有非字串或多行的值：KEY=VALUE 表達不了，維持 JSON
  if (entries.some(([, v]) => typeof v !== 'string' || v.includes('\n'))) return JSON.stringify(env, null, 2);
  const text = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  // 寫成 KEY=VALUE 再讀回來要一模一樣才用；不然（MY-VAR、# 開頭的 key、值前後有空白…）維持 JSON，
  // 免得只改個標記色就存不了，或值被默默改掉
  const back = parseEnv(text);
  if (back.error || Object.keys(back.env).length !== entries.length || entries.some(([k, v]) => back.env[k] !== v)) {
    return JSON.stringify(env, null, 2);
  }
  return text;
}

/** → { env } 或 { error }。值原樣保留（不去引號、不 trim 前面），只去掉行尾的換行 / 空白 */
function parseEnv(text) {
  const src = String(text ?? '');
  if (!src.trim()) return { env: {} };
  if (src.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(src);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'env 的 JSON 要是一個物件' };
      return { env: obj };
    } catch (e) {
      return { error: `env JSON 格式錯誤：${e.message}` };
    }
  }
  // 用 Map 收再轉物件：KEY 叫 __proto__ 之類的也只會是一般欄位
  const env = new Map();
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '');
    const line = raw.trimStart();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) return { error: `env 第 ${i + 1} 行要寫成 KEY=VALUE` };
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) return { error: `env 第 ${i + 1} 行：「${key}」不是合法的變數名稱` };
    if (env.has(key)) return { error: `env 第 ${i + 1} 行：${key} 重複了` };
    env.set(key, body.slice(eq + 1));
  }
  return { env: Object.fromEntries(env) };
}

const parsedEnv = computed(() => parseEnv(envText.value));
const ignoredKeys = computed(() => Object.keys(parsedEnv.value.env ?? {})
  .filter((k) => BLOCKED_EXACT.has(k) || BLOCKED_PREFIX.some((p) => k.startsWith(p))));

function submit() {
  if (props.busy) return;
  localError.value = null;
  const payload = {
    name: name.value.trim(),
    cwd: cwd.value.trim(),
    command: command.value.trim(),
    color: color.value || null,
  };
  const missing = [['name', '名稱'], ['cwd', '資料夾（cwd）'], ['command', '指令']]
    .filter(([k]) => !payload[k]).map(([, label]) => label);
  if (missing.length) {
    localError.value = `請填：${missing.join('、')}`;
    return;
  }
  const { env, error } = parsedEnv.value;
  if (error) {
    localError.value = error;
    return;
  }
  emit('submit', { ...payload, env });
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    // textarea 裡 Enter 是換行；⌘/Ctrl+Enter 直接存
    e.preventDefault();
    submit();
  }
}

onMounted(() => {
  nextTick(() => {
    nameInput.value?.focus();
    if (props.mode === 'new' && name.value) nameInput.value?.select();
  });
});
</script>

<template>
  <form
    class="pform"
    :aria-label="mode === 'new' ? '新增 project' : `編輯 project ${initial.name ?? ''}`"
    novalidate
    @submit.prevent="submit"
    @keydown="onKeydown"
  >
    <div class="pf-head">{{ mode === 'new' ? 'NEW PROJECT' : 'EDIT PROJECT' }}</div>

    <div class="pf-grid">
      <div class="pf-row">
        <label :for="fid('name')">名稱</label>
        <input
          :id="fid('name')"
          ref="nameInput"
          v-model="name"
          placeholder="my-app / claude-station"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </div>
      <div class="pf-row">
        <label :for="fid('cwd')">資料夾（cwd）</label>
        <input
          :id="fid('cwd')"
          v-model="cwd"
          placeholder="~/projects/my-app"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </div>
      <div class="pf-row wide">
        <label :for="fid('command')">指令</label>
        <input
          :id="fid('command')"
          v-model="command"
          class="mono"
          placeholder="claude / claude --channels plugin:discord@claude-plugins-official"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </div>
      <div class="pf-row wide">
        <label :for="fid('env')">環境變數 <span class="opt">選填 · 一行一個 KEY=VALUE</span></label>
        <textarea
          :id="fid('env')"
          v-model="envText"
          class="mono"
          rows="3"
          placeholder="ANTHROPIC_MODEL=claude-opus-5-5"
          autocapitalize="off"
          spellcheck="false"
        />
        <p v-if="ignoredKeys.length" class="pf-warn">
          {{ ignoredKeys.join('、') }} 不會傳給 session（PATH、NODE_PATH、LD_*、DYLD_*、NODE_OPTIONS 一律擋掉）
        </p>
      </div>
      <div class="pf-row wide">
        <span class="pf-label">標記色 <span class="opt">從這個 project 開的新 session 會繼承</span></span>
        <ColorPicker v-model="color" label="Project 標記色" />
      </div>
    </div>

    <p v-if="localError || error" class="pf-error" role="alert">{{ localError || error }}</p>

    <div class="pf-actions">
      <span class="pf-hint">⌘/Ctrl+Enter 儲存 · Esc 取消</span>
      <button type="button" @click="emit('cancel')">取消</button>
      <button type="submit" class="primary" :disabled="busy">{{ busy ? '儲存中…' : '儲存' }}</button>
    </div>
  </form>
</template>

<style scoped>
.pform {
  border: 1px solid var(--amber-dim);
  background: var(--bg-soft);
  padding: 14px 16px 12px;
  box-shadow: 0 0 24px rgba(255, 176, 0, 0.06);
}
.pf-head {
  font-size: 11.5px;
  letter-spacing: 0.2em;
  color: var(--amber);
  margin-bottom: 12px;
}
.pf-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.pf-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.pf-row.wide { grid-column: 1 / -1; }
.pf-row label,
.pf-label {
  font-size: 12px;
  letter-spacing: 0.12em;
  color: var(--dim);
}
.opt {
  margin-left: 6px;
  color: var(--dimmer);
  letter-spacing: 0.04em;
}
.pf-row input,
.pf-row textarea {
  width: 100%;
  min-width: 0;
}
.mono {
  font-family: var(--mono);
  font-size: 15px;
}
.pf-warn {
  margin: 0;
  font-size: 12.5px;
  color: var(--amber-dim);
}
.pf-error {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--danger);
}
.pf-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}
.pf-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--dimmer);
  letter-spacing: 0.04em;
}

@media (max-width: 767px) {
  .pf-grid { grid-template-columns: minmax(0, 1fr); }
  .pf-hint { display: none; }
}
@media (pointer: coarse) {
  .pf-hint { display: none; }
}
</style>
