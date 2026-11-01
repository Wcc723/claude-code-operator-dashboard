<script setup>
// ARTIFACTS：Claude 透過 CODD 的 artifact MCP 發布的 HTML / 畫布。
// 每張卡：標題（點進 /artifact/:id）、kind、來源 session（色點 + 名稱；還活著就能點進 session）、版本、
// 相對更新時間、提交數、Claude 還沒讀的提交數；改名、複製連結、刪除（行內確認，不用 window.confirm）。
// ?session=<terminalId> 只看某個 session 建立的。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { colorHex } from '../colors.js';
import { useSessionsStore } from '../stores/sessions.js';
import RefreshButton from '../components/RefreshButton.vue';
import { fmtDateTime, relTimeFrom } from '../stores/artifact-draft.js';

const route = useRoute();
const router = useRouter();
const store = useSessionsStore();

const root = ref(null);
const items = ref([]);
const loading = ref(false);
const loaded = ref(false);
const error = ref(null);
const now = ref(Date.now());

const renamingId = ref(null);
const renameValue = ref('');
const confirmingId = ref(null);
const busyId = ref(null);
const rowErrors = ref({});
const copiedId = ref(null);

const sessionFilter = computed(() => {
  const s = route.query.session;
  return typeof s === 'string' && s ? s : null;
});
const filterLabel = computed(() => {
  const id = sessionFilter.value;
  if (!id) return '';
  const live = store.byId(id);
  if (live) return live.title || live.profile_name || id.slice(0, 8);
  const fromItem = items.value.find((a) => a.origin?.terminal_id === id || a.origin_terminal_id === id);
  return fromItem?.origin?.label || fromItem?.origin_label || id.slice(0, 8);
});

const indexLabel = computed(() => {
  if (loading.value && !loaded.value) return 'LOADING…';
  const unread = items.value.reduce((n, a) => n + (a.unread_count || 0), 0);
  const n = truncated.value ? `最近 ${items.value.length}` : `${items.value.length}`;
  return `INDEX · ${n} artifacts${unread ? ` · Claude 未讀 ${unread}` : ''}`;
});

// server 一次最多給 200 個（依更新時間新到舊），目前沒有分頁：剛好拿滿就提示「只顯示最近 N 個」
const LIST_LIMIT = 200;
const truncated = computed(() => loaded.value && items.value.length >= LIST_LIMIT);

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  try {
    const res = await api.listArtifacts({ session: sessionFilter.value, limit: LIST_LIMIT });
    if (seq !== loadSeq) return;
    items.value = Array.isArray(res?.items) ? res.items : [];
    error.value = null;
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e.message;
  } finally {
    if (seq === loadSeq) {
      loading.value = false;
      loaded.value = true;
    }
  }
}

watch(sessionFilter, load);

function clearFilter() {
  const query = { ...route.query };
  delete query.session;
  router.replace({ query });
}

// ───── 顯示用 ─────
// 用 host token 建的（不是 CODD 開的 session）沒有來源：origin 欄位全是 null
function originOf(a) {
  const o = a.origin;
  if (o && (o.terminal_id || o.label)) return o;
  return a.origin_label || a.origin_terminal_id
    ? { terminal_id: a.origin_terminal_id ?? null, label: a.origin_label ?? null, alive: false, color: null }
    : null;
}
function originLink(a) {
  const o = originOf(a);
  const id = o?.live_id || o?.terminal_id;
  return o?.alive && id ? `/sessions/${id}` : null;
}
function originHex(a) {
  return colorHex(originOf(a)?.color);
}
function kindLabel(a) {
  return a.kind === 'canvas' ? 'CANVAS' : 'HTML';
}
function artifactUrl(a) {
  return `${location.origin}/artifact/${a.id}`;
}

// ───── 行內錯誤 ─────
function setRowError(id, msg) {
  rowErrors.value = { ...rowErrors.value, [id]: msg };
}
function clearRowError(id) {
  if (!(id in rowErrors.value)) return;
  const { [id]: _, ...rest } = rowErrors.value;
  rowErrors.value = rest;
}

function focusIn(selector) {
  nextTick(() => root.value?.querySelector(selector)?.focus());
}

// ───── 改名 ─────
function startRename(a) {
  confirmingId.value = null;
  renamingId.value = a.id;
  renameValue.value = a.title;
  clearRowError(a.id);
  focusIn(`[data-rename-input="${a.id}"]`);
}

function cancelRename(a) {
  renamingId.value = null;
  focusIn(`[data-rename="${a.id}"]`);
}

async function submitRename(a) {
  const title = renameValue.value.trim();
  if (!title) {
    setRowError(a.id, '標題不能是空的');
    return;
  }
  if (title === a.title) {
    cancelRename(a);
    return;
  }
  if (busyId.value) return;
  busyId.value = a.id;
  clearRowError(a.id);
  try {
    const res = await api.renameArtifact(a.id, title);
    const next = res?.artifact ?? { ...a, title };
    items.value = items.value.map((x) => (x.id === a.id ? { ...x, ...next, origin: next.origin ?? x.origin } : x));
    renamingId.value = null;
    focusIn(`[data-rename="${a.id}"]`);
  } catch (e) {
    setRowError(a.id, `改名失敗：${e.message}`);
  } finally {
    busyId.value = null;
  }
}

function onRenameKeydown(e, a) {
  if (e.key === 'Escape' && !e.isComposing) {
    e.stopPropagation();
    cancelRename(a);
  }
}

// ───── 刪除：行內確認 ─────
function askDelete(a) {
  renamingId.value = null;
  confirmingId.value = a.id;
  clearRowError(a.id);
  focusIn(`[data-cancel-delete="${a.id}"]`);
}

function cancelDelete(a) {
  confirmingId.value = null;
  focusIn(`[data-delete="${a.id}"]`);
}

async function doDelete(a) {
  if (busyId.value) return;
  busyId.value = a.id;
  clearRowError(a.id);
  try {
    await api.deleteArtifact(a.id);
    confirmingId.value = null;
    const idx = items.value.findIndex((x) => x.id === a.id);
    items.value = items.value.filter((x) => x.id !== a.id);
    // 焦點移到下一張（或上一張）卡的標題，不要掉回 body
    const next = items.value[Math.min(idx, items.value.length - 1)];
    if (next) focusIn(`[data-open="${next.id}"]`);
    else nextTick(() => root.value?.focus());
  } catch (e) {
    setRowError(a.id, `刪除失敗：${e.message}`);
  } finally {
    busyId.value = null;
  }
}

function onCardKeydown(e, a) {
  if (e.key === 'Escape' && confirmingId.value === a.id) {
    e.stopPropagation();
    cancelDelete(a);
  }
}

// ───── 複製連結（遠端用 https://<codd 網域>/artifact/<id> 開）─────
let copiedTimer = null;
async function copyLink(a) {
  const url = artifactUrl(a);
  clearRowError(a.id);
  try {
    await navigator.clipboard.writeText(url);
    copiedId.value = a.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1800);
  } catch {
    // 非 https（區網 http 直連）沒有 clipboard API：把網址秀出來讓使用者自己複製
    setRowError(a.id, `沒辦法自動複製，網址：${url}`);
  }
}

// ───── 生命週期 ─────
let clock = null;
function onVisibility() {
  if (!document.hidden) {
    now.value = Date.now();
    load();
  }
}

onMounted(() => {
  load();
  clock = setInterval(() => { now.value = Date.now(); }, 30000);
  document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
  clearInterval(clock);
  clearTimeout(copiedTimer);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <div ref="root" class="arts" tabindex="-1">
    <div class="toolbar">
      <h2 style="margin: 0">ARTIFACTS</h2>
      <span class="spacer" />
      <RefreshButton :on-refresh="load" />
    </div>
    <p class="section-meta">{{ indexLabel }}</p>
    <p class="intro">
      Claude 在 CODD 開的 session 裡用 artifact_create 發布的頁面與設計畫布。存在這台主機上，切換 Claude 帳號也看得到。
    </p>

    <div v-if="sessionFilter" class="filter" role="status">
      <span>只顯示 session「<strong>{{ filterLabel }}</strong>」建立的 artifact</span>
      <button type="button" class="small" @click="clearFilter">顯示全部</button>
    </div>

    <p v-if="loading && !loaded" class="notice">// loading …</p>
    <p v-else-if="error && !items.length" class="error">讀取 artifacts 失敗：{{ error }}</p>
    <div v-else-if="loaded && !items.length" class="empty">
      <p class="notice">
        <template v-if="sessionFilter">// 這個 session 還沒有發布 artifact。</template>
        <template v-else>// 還沒有 artifact。</template>
      </p>
      <p class="empty-help">
        在 CODD 開的 Claude session 裡請它用 <code>artifact_create</code> 發布，例如：
        「把這三個首頁版本做成 canvas artifact 給我挑」。發布後會出現在這裡，網址是 <code>/artifact/&lt;id&gt;</code>。
      </p>
    </div>
    <p v-if="error && items.length" class="error small-error">更新失敗：{{ error }}</p>
    <p v-if="truncated" class="notice small-note" role="status">
      只顯示最近更新的 {{ items.length }} 個 artifact；更舊的還在，可以用網址 /artifact/&lt;id&gt; 直接開。
    </p>

    <ul class="alist" aria-label="Artifacts">
      <li
        v-for="a in items"
        :key="a.id"
        class="art"
        :style="originHex(a) ? { '--oc': originHex(a) } : null"
        @keydown="onCardKeydown($event, a)"
      >
        <div class="a-top">
          <span class="a-kind" :class="a.kind">{{ kindLabel(a) }}</span>
          <form
            v-if="renamingId === a.id"
            class="a-rename"
            @submit.prevent="submitRename(a)"
            @keydown="onRenameKeydown($event, a)"
          >
            <input
              v-model="renameValue"
              :data-rename-input="a.id"
              type="text"
              maxlength="120"
              aria-label="新標題"
              autocomplete="off"
              :disabled="busyId === a.id"
            />
            <button type="submit" class="small primary" :disabled="busyId === a.id">{{ busyId === a.id ? '儲存中…' : '儲存' }}</button>
            <button type="button" class="small" :disabled="busyId === a.id" @click="cancelRename(a)">取消</button>
          </form>
          <RouterLink v-else :to="`/artifact/${a.id}`" class="a-title" :data-open="a.id">{{ a.title }}</RouterLink>
        </div>

        <div class="a-meta">
          <span class="a-ver">v{{ a.current_version }}</span>
          <span class="a-time" :title="`更新於 ${fmtDateTime(a.updated_at)}`">{{ relTimeFrom(a.updated_at, now) }}更新</span>
          <span class="a-subs" :class="{ zero: !a.submission_count }">提交 {{ a.submission_count || 0 }}</span>
          <span
            v-if="a.unread_count"
            class="a-unread"
            :title="'使用者提交了，但 Claude 還沒用 artifact_read_submissions 讀取'"
          >Claude 未讀 {{ a.unread_count }}</span>
        </div>

        <div v-if="originOf(a)" class="a-origin">
          <span class="a-odot" :class="{ ended: !originOf(a).alive }" aria-hidden="true" />
          <RouterLink
            v-if="originLink(a)"
            :to="originLink(a)"
            class="a-olink"
            :title="`進入 session：${originOf(a).label || ''}`"
          >{{ originOf(a).label || 'session' }}</RouterLink>
          <span v-else class="a-oname">{{ originOf(a).label || 'session' }}</span>
          <span v-if="!originOf(a).alive" class="a-oended">已結束</span>
          <!-- 篩選用建立當下的 session id（origin.terminal_id 是 restart 之後現在活著的那個） -->
          <RouterLink
            v-if="!sessionFilter && a.origin_terminal_id"
            :to="{ path: '/artifacts', query: { session: a.origin_terminal_id } }"
            class="a-ofilter"
            :title="'只看這個 session 建立的 artifact'"
          >同 session</RouterLink>
        </div>

        <p v-if="rowErrors[a.id]" class="row-error" role="alert">{{ rowErrors[a.id] }}</p>

        <div v-if="confirmingId === a.id" class="a-confirm" role="group" :aria-label="`確認刪除 ${a.title}`">
          <span class="confirm-text">確定刪除「{{ a.title }}」？Claude 也會讀不到它和所有提交。</span>
          <button
            type="button"
            class="danger small"
            :disabled="busyId === a.id"
            @click="doDelete(a)"
          >{{ busyId === a.id ? '刪除中…' : '確定刪除' }}</button>
          <button type="button" class="small" :data-cancel-delete="a.id" @click="cancelDelete(a)">取消</button>
        </div>
        <div v-else-if="renamingId !== a.id" class="a-actions">
          <RouterLink :to="`/artifact/${a.id}`" class="a-open">開啟 →</RouterLink>
          <span class="a-spacer" />
          <button type="button" class="link" @click="copyLink(a)">{{ copiedId === a.id ? '已複製' : '複製連結' }}</button>
          <button type="button" class="link" :data-rename="a.id" @click="startRename(a)">改名</button>
          <button type="button" class="link danger-link" :data-delete="a.id" @click="askDelete(a)">刪除</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.arts {
  max-width: 980px;
  outline: none;
}
.intro {
  margin: -6px 0 18px;
  font-size: 13.5px;
  color: var(--dimmer);
  letter-spacing: 0.02em;
}
.filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 0 0 14px;
  padding: 8px 12px;
  border: 1px dashed var(--amber-dim);
  font-size: 13.5px;
  color: var(--bone);
}
.filter > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.filter strong { color: var(--amber); font-weight: 500; }
.empty {
  margin: 8px 0 18px;
}
.empty-help {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--dim);
}
.empty-help code {
  font-size: 13px;
  color: var(--amber-dim);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  padding: 0 5px;
}
.small-error {
  font-size: 13px;
  margin: 0 0 10px;
}
.small-note {
  font-size: 12.5px;
  margin: 0 0 10px;
  font-family: var(--cjk);
}

.alist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 卡片：左邊 3px = 來源 session 的標記色（沒有就是暗線） */
.art {
  --oc: var(--line-bright);
  position: relative;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-left: 3px solid var(--oc);
  padding: 12px 16px 10px 16px;
  min-width: 0;
  transition: border-color 120ms;
}
.art:hover {
  border-top-color: var(--line-bright);
  border-right-color: var(--line-bright);
  border-bottom-color: var(--line-bright);
}

.a-top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.a-kind {
  flex: none;
  padding: 0 6px;
  border: 1px solid currentColor;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  color: var(--cyan);
}
.a-kind.canvas { color: var(--amber-dim); }
.a-title {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--cream);
  border-bottom: none;
  padding: 0;
  overflow-wrap: anywhere;
}
.a-title:hover { color: var(--amber); }
.a-rename {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.a-rename input {
  flex: 1 1 220px;
  min-width: 0;
  padding: 4px 8px;
}

.a-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin-top: 6px;
  font-size: 13px;
  color: var(--dim);
}
.a-ver { color: var(--bone); }
.a-subs.zero { color: var(--dimmer); }
.a-unread {
  color: #000;
  background: var(--amber);
  padding: 0 6px;
  font-size: 12px;
  letter-spacing: 0.04em;
}

.a-origin {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--bone);
  min-width: 0;
}
.a-odot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--oc);
}
.a-odot.ended {
  background: transparent;
  border: 1px dashed var(--dimmer);
}
.a-olink {
  border-bottom: none;
  padding: 0;
  color: var(--bone);
  overflow-wrap: anywhere;
}
.a-olink:hover { color: var(--amber); }
.a-oname { color: var(--dim); overflow-wrap: anywhere; }
.a-oended { color: var(--dimmer); font-size: 11.5px; }
.a-ofilter {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--dimmer);
  border-bottom-color: var(--line-bright);
}
.a-ofilter:hover { color: var(--amber); }

.row-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--danger);
  word-break: break-word;
}

.a-actions,
.a-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.a-open {
  font-size: 13px;
  letter-spacing: 0.06em;
}
.a-spacer { flex: 1; }
.confirm-text {
  flex: 1;
  min-width: 200px;
  font-size: 13.5px;
  color: var(--cream);
}

/* 文字型按鈕（同 PROJECTS 卡片底部） */
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
button.link.danger-link:hover { color: var(--danger); }
button.small {
  font-size: 12.5px;
  padding: 4px 10px;
}
.arts :is(button, a, input):focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 1px;
}

@media (max-width: 767px) {
  .art { padding: 12px 12px 8px; }
  .a-title { font-size: 16px; }
  .a-ofilter { margin-left: 0; }
  .a-open { min-height: 40px; display: inline-flex; align-items: center; }
}
@media (pointer: coarse) {
  button.link { min-height: 40px; padding: 4px 12px; }
  .a-olink, .a-ofilter { min-height: 32px; display: inline-flex; align-items: center; }
}
</style>
