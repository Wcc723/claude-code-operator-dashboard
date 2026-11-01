<script setup>
// PROJECTS（原 LAUNCH PROFILES）：一個 project = 在哪個資料夾、用什麼指令開 session，外加標記色。
// 列表直接用 sessions store 的 profiles（跟 + NEW 選單、首頁同一份），改完呼叫 store.loadProfiles() 讓各處同步；
// 開 session 走 store.spawn（同 NewSessionButton），開完直接進那個 session。
import { computed, nextTick, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { api } from '../api.js';
import { useSessionsStore, sessionState, STATE_META } from '../stores/sessions.js';
import { colorHex, colorMeta } from '../colors.js';
import ProjectForm from '../components/ProjectForm.vue';
import RefreshButton from '../components/RefreshButton.vue';

const store = useSessionsStore();
const router = useRouter();

const root = ref(null);
const loading = ref(false);
const editing = ref(null);     // null | 'new' | project id
const draft = ref(null);       // 新增表單的初始值（+ NEW 或「複製」）
const draftSeq = ref(0);       // 換一份 draft 就重建表單
const saving = ref(false);
const formError = ref(null);
const confirmingId = ref(null); // 正在確認刪除的 project
const deletingId = ref(null);
const spawningId = ref(null);
const rowErrors = ref({});     // project id → 錯誤訊息（開 session / 刪除失敗）
const flashId = ref(null);     // 剛存好的那張卡片閃一下
let flashTimer = null;

const projects = computed(() => store.profiles);

// 依 profile_id 分組目前在跑的 session（store.active 已照側欄順序排好）
const runningByProject = computed(() => {
  const map = new Map();
  for (const s of store.active) {
    if (s.profile_id == null) continue;
    const list = map.get(s.profile_id) ?? [];
    list.push(s);
    map.set(s.profile_id, list);
  }
  return map;
});
const runningOf = (p) => runningByProject.value.get(p.id) ?? [];
const runningTotal = computed(() => projects.value.reduce((n, p) => n + runningOf(p).length, 0));

const indexLabel = computed(() => {
  if (loading.value && !projects.value.length) return 'LOADING…';
  return `INDEX · ${projects.value.length} projects · ${runningTotal.value} running`;
});

async function load() {
  loading.value = true;
  try {
    await store.loadProfiles();
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ───── 新增 / 複製 / 編輯 ─────
function openForm(target, initial) {
  editing.value = target;
  draft.value = initial;
  draftSeq.value++;
  formError.value = null;
  confirmingId.value = null;
}

function startCreate() {
  openForm('new', { name: '', cwd: '', command: 'claude', env: {}, color: null });
}

function duplicate(p) {
  // 避免撞 UNIQUE name，自動加 -copy / -copy-2 / -copy-3 ...
  const existing = new Set(projects.value.map((x) => x.name));
  let candidate = `${p.name}-copy`;
  let n = 2;
  while (existing.has(candidate)) candidate = `${p.name}-copy-${n++}`;
  openForm('new', { name: candidate, cwd: p.cwd, command: p.command, env: { ...(p.env || {}) }, color: p.color ?? null });
}

function startEdit(p) {
  openForm(p.id, { name: p.name, cwd: p.cwd, command: p.command, env: p.env || {}, color: p.color ?? null });
}

function cancelForm() {
  const was = editing.value;
  editing.value = null;
  formError.value = null;
  if (typeof was === 'number') focusIn(`[data-edit="${was}"]`);
}

async function submit(payload) {
  if (saving.value) return;
  saving.value = true;
  formError.value = null;
  try {
    const saved = editing.value === 'new'
      ? await api.createProfile(payload)
      : await api.updateProfile(editing.value, payload);
    editing.value = null;
    await store.loadProfiles();
    if (saved?.id != null) {
      flash(saved.id);
      focusIn(`[data-edit="${saved.id}"]`, { scroll: true });
    }
  } catch (e) {
    formError.value = e.status === 409
      ? `已經有叫「${payload.name}」的 project 了，換個名字`
      : e.message;
  } finally {
    saving.value = false;
  }
}

function flash(id) {
  flashId.value = id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashId.value = null; }, 1600);
}

function focusIn(selector, { scroll = false } = {}) {
  nextTick(() => {
    const el = root.value?.querySelector(selector);
    if (!el) return;
    el.focus({ preventScroll: !scroll });
    if (scroll) el.closest('.proj')?.scrollIntoView({ block: 'nearest' });
  });
}

function setRowError(id, msg) {
  rowErrors.value = { ...rowErrors.value, [id]: msg };
}
function clearRowError(id) {
  if (!(id in rowErrors.value)) return;
  const { [id]: _, ...rest } = rowErrors.value;
  rowErrors.value = rest;
}

// ───── 刪除：行內確認（不用 window.confirm）─────
function askDelete(p) {
  confirmingId.value = p.id;
  clearRowError(p.id);
  focusIn(`[data-cancel-delete="${p.id}"]`);
}

function cancelDelete(p) {
  confirmingId.value = null;
  focusIn(`[data-delete="${p.id}"]`);
}

async function doDelete(p) {
  if (deletingId.value) return;
  deletingId.value = p.id;
  clearRowError(p.id);
  try {
    await api.deleteProfile(p.id);
    confirmingId.value = null;
    if (editing.value === p.id) editing.value = null;
    await store.loadProfiles();
  } catch (e) {
    setRowError(p.id, `刪除失敗：${e.message}`);
  } finally {
    deletingId.value = null;
  }
}

// ───── 開新 session ─────
async function launch(p) {
  if (spawningId.value) return;
  spawningId.value = p.id;
  clearRowError(p.id);
  try {
    const s = await store.spawn(p.id);
    router.push(`/sessions/${s.id}`);
  } catch (e) {
    setRowError(p.id, e.message);
  } finally {
    spawningId.value = null;
  }
}

function onCardKeydown(e, p) {
  if (e.key === 'Escape' && confirmingId.value === p.id) {
    e.stopPropagation();
    cancelDelete(p);
  }
}

// ───── 顯示用 ─────
function envKeys(p) {
  return Object.keys(p.env || {});
}
function sessionTitle(s) {
  return s.title || s.profile_name || s.id.slice(0, 8);
}
function stateOf(s) {
  return sessionState(s);
}
</script>

<template>
  <div ref="root" class="projects">
    <div class="toolbar">
      <h2 style="margin: 0">PROJECTS</h2>
      <span class="spacer" />
      <button class="primary" :disabled="editing === 'new'" @click="startCreate">+ NEW</button>
      <RefreshButton :on-refresh="load" />
    </div>
    <p class="section-meta">{{ indexLabel }}</p>
    <p class="intro">
      project = 在哪個資料夾、用什麼指令開 session。標記色會被之後新開的 session 繼承（session 也可以各自改色）。
    </p>

    <ProjectForm
      v-if="editing === 'new'"
      :key="`new-${draftSeq}`"
      class="new-form"
      mode="new"
      :initial="draft"
      :busy="saving"
      :error="formError"
      @submit="submit"
      @cancel="cancelForm"
    />

    <p v-if="loading && !projects.length" class="notice">// loading …</p>
    <p v-else-if="!projects.length && store.error" class="error">讀取 projects 失敗：{{ store.error }}</p>
    <div v-else-if="!projects.length && editing !== 'new'" class="empty">
      <p class="notice">// 還沒有 project — 先建一個，就能從側欄的 + NEW 開 session</p>
      <button class="primary" @click="startCreate">+ 建立第一個 project</button>
    </div>

    <ul class="plist" aria-label="Projects">
      <li
        v-for="p in projects"
        :key="p.id"
        class="proj"
        :class="{ flash: flashId === p.id, editing: editing === p.id, colored: !!colorHex(p.color) }"
        :style="colorHex(p.color) ? { '--pc': colorHex(p.color) } : null"
        @keydown="onCardKeydown($event, p)"
      >
        <ProjectForm
          v-if="editing === p.id"
          :key="`edit-${p.id}-${draftSeq}`"
          mode="edit"
          :initial="draft"
          :busy="saving"
          :error="formError"
          @submit="submit"
          @cancel="cancelForm"
        />

        <template v-else>
          <div class="p-top">
            <div class="p-ident">
              <h3 class="p-name">{{ p.name }}</h3>
              <span v-if="colorMeta(p.color)" class="p-color">{{ colorMeta(p.color).label }}色</span>
            </div>
            <button
              type="button"
              class="primary p-launch"
              :disabled="!!spawningId"
              :aria-label="`用 ${p.name} 開新 session`"
              @click="launch(p)"
            >{{ spawningId === p.id ? '開啟中…' : '▶ 開新 session' }}</button>
          </div>

          <div class="p-cwd" :title="p.cwd">{{ p.cwd }}</div>
          <div class="p-cmd"><span class="p-prompt">$</span> {{ p.command }}</div>

          <div class="p-meta">
            <span
              v-if="envKeys(p).length"
              class="chip"
              :title="`環境變數：${envKeys(p).join(', ')}`"
            >ENV ×{{ envKeys(p).length }}</span>
            <span v-else class="chip dim">NO ENV</span>

            <template v-if="runningOf(p).length">
              <span class="running-label">執行中 {{ runningOf(p).length }}</span>
              <RouterLink
                v-for="s in runningOf(p)"
                :key="s.id"
                :to="`/sessions/${s.id}`"
                class="sess"
                :class="`st-${stateOf(s)}`"
                :style="colorHex(s.color) ? { '--sc': colorHex(s.color) } : null"
                :title="`${sessionTitle(s)} · ${STATE_META[stateOf(s)].label}`"
              >
                <span class="lamp" aria-hidden="true">{{ STATE_META[stateOf(s)].glyph }}</span>
                <span class="sess-name">{{ sessionTitle(s) }}</span>
                <span class="visually-hidden">（{{ STATE_META[stateOf(s)].label }}）</span>
              </RouterLink>
            </template>
            <span v-else class="idle-label">沒有執行中的 session</span>
          </div>

          <p v-if="rowErrors[p.id]" class="row-error" role="alert">{{ rowErrors[p.id] }}</p>

          <div v-if="confirmingId === p.id" class="p-confirm" role="group" :aria-label="`確認刪除 ${p.name}`">
            <span class="confirm-text">
              確定刪除「{{ p.name }}」？
              <template v-if="runningOf(p).length">
                它的 {{ runningOf(p).length }} 個執行中 session 不會被關掉，但結束後就不能再 RESTART。
              </template>
            </span>
            <button
              type="button"
              class="danger small"
              :disabled="deletingId === p.id"
              @click="doDelete(p)"
            >{{ deletingId === p.id ? '刪除中…' : '確定刪除' }}</button>
            <button type="button" class="small" :data-cancel-delete="p.id" @click="cancelDelete(p)">取消</button>
          </div>
          <div v-else class="p-actions">
            <button type="button" class="link" :data-edit="p.id" @click="startEdit(p)">編輯</button>
            <button type="button" class="link" @click="duplicate(p)">複製</button>
            <button type="button" class="link danger-link" :data-delete="p.id" @click="askDelete(p)">刪除</button>
          </div>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.projects {
  max-width: 980px;
}
.intro {
  margin: -6px 0 18px;
  font-size: 13.5px;
  color: var(--dimmer);
  letter-spacing: 0.02em;
}
.new-form {
  margin-bottom: 14px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 0 18px;
}

.plist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 卡片：左邊 3px 標記色條（沒顏色就是暗線） */
.proj {
  --pc: var(--line-bright);
  position: relative;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-left: 3px solid var(--pc);
  padding: 12px 16px 10px 16px;
  min-width: 0;
  transition: border-color 120ms;
}
.proj:hover:not(.editing) {
  border-top-color: var(--line-bright);
  border-right-color: var(--line-bright);
  border-bottom-color: var(--line-bright);
}
.proj.editing {
  padding: 0;
  border: none;
  background: transparent;
}
.proj.flash {
  animation: proj-flash 1.4s ease-out;
}
@keyframes proj-flash {
  0%, 30% { box-shadow: 0 0 0 1px var(--amber), 0 0 18px var(--amber-glow); }
  100% { box-shadow: none; }
}

.p-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.p-ident {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.p-name {
  margin: 0;
  font-family: var(--mono);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--cream);
  overflow-wrap: anywhere;
}
.p-color {
  font-size: 11.5px;
  letter-spacing: 0.08em;
  color: var(--pc);
}
.p-launch {
  flex: none;
  font-size: 13px;
  padding: 5px 12px;
}

.p-cwd {
  margin-top: 4px;
  font-size: 13.5px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-cmd {
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 13.5px;
  color: var(--amber-dim);
  word-break: break-all;
  line-height: 1.5;
}
.p-prompt {
  color: var(--dimmer);
}

.p-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin-top: 10px;
  font-size: 12.5px;
}
.chip {
  border: 1px solid var(--line-bright);
  color: var(--bone);
  padding: 1px 8px;
  font-size: 11.5px;
  letter-spacing: 0.1em;
}
.chip.dim {
  color: var(--dimmer);
  border-color: var(--line);
}
.running-label {
  color: var(--success);
  letter-spacing: 0.06em;
  margin-left: 4px;
}
.idle-label {
  color: var(--dimmer);
  margin-left: 4px;
}

/* 執行中的 session：點了直接進去。左邊色條 = session 自己的標記色，燈號顏色照狀態 */
.sess {
  --sc: transparent;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  min-height: 26px;
  padding: 1px 8px 1px 6px;
  border: 1px solid var(--line-bright);
  border-left: 3px solid var(--sc);
  color: var(--bone);
  font-size: 12.5px;
}
.sess:hover {
  border-color: var(--amber);
  border-left-color: var(--sc);
  color: var(--cream);
}
.sess-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.lamp { font-size: 10px; flex: none; }
.sess.st-waiting .lamp { color: var(--amber); }
.sess.st-busy .lamp { color: var(--success); }
.sess.st-idle .lamp { color: var(--cyan); }
.sess.st-unknown .lamp { color: var(--dimmer); }

.row-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--danger);
  word-break: break-word;
}

.p-actions,
.p-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.p-actions {
  justify-content: flex-end;
}
.confirm-text {
  flex: 1;
  min-width: 200px;
  font-size: 13.5px;
  color: var(--cream);
}

/* 文字型按鈕：卡片底部的 編輯 / 複製 / 刪除 */
button.link {
  border: none;
  padding: 4px 8px;
  font-size: 12.5px;
  letter-spacing: 0.1em;
  color: var(--dim);
}
button.link::before,
button.link::after { content: none; }
button.link:hover {
  color: var(--amber);
  box-shadow: none;
}
button.link.danger-link:hover {
  color: var(--danger);
}
button.link:focus-visible,
.sess:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 1px;
}
button.small {
  font-size: 12.5px;
  padding: 4px 10px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 767px) {
  .proj { padding: 12px 12px 8px; }
  .p-top { gap: 8px; }
  .p-launch { font-size: 12px; padding: 4px 8px; letter-spacing: 0.04em; }
  .p-cwd { white-space: normal; word-break: break-all; }
  .sess { max-width: 100%; min-height: 36px; }
}
@media (pointer: coarse) {
  button.link { min-height: 40px; padding: 4px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .proj.flash { animation: none; }
}
</style>
