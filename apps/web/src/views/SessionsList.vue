<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { useSessionsStore, sessionState, STATE_META } from '../stores/sessions.js';

const router = useRouter();
const store = useSessionsStore();
const sessions = ref([]);
const profiles = ref([]);
const selectedProfileId = ref(null);
const loading = ref(true);
const spawning = ref(false);
const error = ref(null);
const showRemoved = ref(false);

async function load() {
  loading.value = true;
  try {
    const [s, p] = await Promise.all([api.listSessions(), api.listProfiles()]);
    sessions.value = s.items;
    profiles.value = p.items;
    if (!selectedProfileId.value && p.items.length) selectedProfileId.value = p.items[0].id;
  } finally { loading.value = false; }
}

// 預設隱藏已移除的 session，showRemoved 打開才顯示
const visibleSessions = computed(() =>
  showRemoved.value ? sessions.value : sessions.value.filter(s => !s.removed)
);
const removedCount = computed(() => sessions.value.filter(s => s.removed).length);

function enter(id) {
  router.push(`/sessions/${id}`);
}

async function spawn() {
  if (!selectedProfileId.value) return;
  error.value = null;
  spawning.value = true;
  try {
    await api.spawnSession(selectedProfileId.value);
    await load();
    store.refresh({ force: true });
  } catch (e) { error.value = e.message; }
  finally { spawning.value = false; }
}

async function kill(id) {
  if (!confirm('Kill this session?')) return;
  await api.killSession(id);
  await load();
  store.refresh({ force: true });
}

async function restart(id) {
  await api.restartSession(id);
  await load();
  store.refresh({ force: true });
}

async function remove(id) {
  if (!confirm('Remove this session from the list? (執行中會先 kill)')) return;
  await api.removeSession(id);
  await load();
  store.refresh({ force: true });
}

onMounted(load);

const indexLabel = computed(() => {
  if (loading.value) return '';
  const running = visibleSessions.value.filter(s => s.status === 'running').length;
  return `INDEX · ${visibleSessions.value.length} sessions · ${running} running`;
});

function stateOf(s) {
  return sessionState(s);
}

function runtime(s) {
  if (!s.started_at) return '—';
  const start = Date.parse(s.started_at);
  const end = s.exited_at ? Date.parse(s.exited_at) : Date.now();
  const secs = Math.floor((end - start) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(secs % 60).padStart(2, '0')}s`;
}
</script>

<template>
  <div class="toolbar">
    <h2 style="margin: 0">SESSIONS</h2>
    <span class="spacer" />
    <label class="filter" title="顯示已移除的 session">
      <input type="checkbox" v-model="showRemoved" />
      show removed<span v-if="removedCount" class="notice"> ({{ removedCount }})</span>
    </label>
    <select v-model="selectedProfileId" style="margin-right: 8px">
      <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <button class="primary" :disabled="spawning || !selectedProfileId" @click="spawn">+ NEW</button>
    <button @click="load">↻ REFRESH</button>
  </div>
  <p class="section-meta">{{ indexLabel || 'LOADING…' }}</p>
  <p v-if="error" class="error">{{ error }}</p>

  <p v-if="loading" class="notice">// loading …</p>
  <p v-else-if="!sessions.length" class="notice">// no sessions — click + NEW to spawn</p>
  <p v-else-if="!visibleSessions.length" class="notice">// all sessions removed — 勾選 show removed 以顯示</p>
  <div v-else>
    <div
      v-for="s in visibleSessions"
      :key="s.id"
      class="list-item clickable"
      :class="{ removed: s.removed }"
      role="button"
      tabindex="0"
      @click="enter(s.id)"
      @keydown.enter="enter(s.id)"
      @keydown.space.prevent="enter(s.id)"
    >
      <div class="row">
        <span :class="['lamp', `st-${stateOf(s)}`]">{{ STATE_META[stateOf(s)].glyph }}</span>
        <strong :title="s.last_prompt ? `最近 prompt：${s.last_prompt}` : undefined">{{ s.title || s.profile_name }}</strong>
        <span class="notice">·  {{ s.id.slice(0, 8) }}</span>
        <span :class="['chip', s.status === 'running' ? 'primary' : 'dim']">{{ s.status }}</span>
        <span v-if="s.status === 'running' && s.activity" :class="['chip', 'state', `st-${stateOf(s)}`]">{{ STATE_META[stateOf(s)].label }}</span>
        <span v-if="s.title && s.profile_name" class="chip dim">{{ s.profile_name }}</span>
        <span v-if="s.removed" class="chip dim">removed</span>
        <span class="chip">pid: {{ s.pid }}</span>
        <span class="chip">run: {{ runtime(s) }}</span>
        <span v-if="s.restart_count" class="chip">restarts: {{ s.restart_count }}</span>
        <span class="spacer" />
        <button v-if="s.status === 'running'" @click.stop="kill(s.id)" class="danger">KILL</button>
        <button @click.stop="restart(s.id)">RESTART</button>
        <button v-if="!s.removed" @click.stop="remove(s.id)" class="danger">REMOVE</button>
      </div>
      <div class="meta">
        <span v-if="s.cwd_short || s.cwd" class="cwd">{{ s.cwd_short || s.cwd }}</span>
        → <code>{{ s.command }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.clickable { cursor: pointer; transition: border-color 0.12s, background 0.12s; }
.clickable:hover { border-color: var(--amber); background: var(--bg-soft); }
.clickable:hover strong { color: var(--amber); }
.removed { opacity: 0.55; }
.filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 12px;
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--dim);
  text-transform: lowercase;
  cursor: pointer;
}
.chip {
  background: transparent;
  border: 1px solid var(--line-bright);
  color: var(--bone);
  padding: 2px 10px;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  font-family: var(--mono);
}
.chip.primary { background: var(--success); border-color: var(--success); color: #000; }
.chip.dim { color: var(--dim); }
.spacer { flex: 1; }
.lamp { width: 12px; text-align: center; font-size: 12px; }
.st-waiting { color: var(--amber); }
.st-busy { color: var(--success); }
.st-idle { color: var(--cyan); }
.st-unknown { color: var(--bone); }
.st-ended { color: var(--dimmer); }
.chip.state { border-color: currentColor; text-transform: uppercase; }
.chip.state.st-waiting { background: var(--amber); border-color: var(--amber); color: #000; }
.cwd { color: var(--dim); margin-right: 10px; }
</style>
