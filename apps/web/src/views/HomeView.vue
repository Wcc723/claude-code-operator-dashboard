<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { api } from '../api.js';
import { useSessionsStore } from '../stores/sessions.js';
import SetupGuide from '../components/SetupGuide.vue';

const store = useSessionsStore();
const router = useRouter();

const decided = ref(false);
const redirecting = ref(false);
const setup = ref(null);
const spawningId = ref(null);
const error = ref(null);

const recentStopped = computed(() => store.stopped.slice(0, 3));

function ts(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

async function loadSetup() {
  try {
    setup.value = await api.getSetup();
  } catch {
    setup.value = null;
  }
}

// 首頁只是入口：有 session 在跑就直接進最近開的那個；沒有才顯示啟動面板。
// 第一次抓失敗（手機剛醒、網路不穩）時 items 是空的，不能據此下結論，等下一次成功的 poll
watch([() => store.loaded, () => store.error], ([loaded, err]) => {
  if (!loaded || err || decided.value) return;
  decided.value = true;
  const target = [...store.active].sort((a, b) => ts(b.started_at) - ts(a.started_at))[0];
  if (target) {
    redirecting.value = true;
    router.replace(`/sessions/${target.id}`);
    return;
  }
  loadSetup();
}, { immediate: true });

onMounted(() => {
  if (!store.profiles.length) store.loadProfiles();
});

async function launch(p) {
  if (spawningId.value) return;
  spawningId.value = p.id;
  error.value = null;
  try {
    const s = await store.spawn(p.id);
    router.push(`/sessions/${s.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    spawningId.value = null;
  }
}

async function restart(s) {
  if (spawningId.value) return;
  spawningId.value = s.id;
  error.value = null;
  try {
    const fresh = await store.restart(s.id);
    router.push(`/sessions/${fresh.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    spawningId.value = null;
  }
}

function fmtWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <div class="home">
    <p v-if="!decided || redirecting" class="notice">
      // loading …<template v-if="store.error && !redirecting">（{{ store.error }}，稍後自動重試）</template>
    </p>

    <template v-else>
      <h2>FANCY/CODD</h2>
      <p class="section-meta">NO ACTIVE SESSION · 選一個 profile 開始</p>
      <p v-if="error" class="error">{{ error }}</p>

      <section class="card launch">
        <h3>LAUNCH</h3>
        <p v-if="!store.profiles.length" class="notice">
          // 還沒有 launch profile — <RouterLink to="/profiles">到 PROFILES 建立一個 →</RouterLink>
        </p>
        <div v-else class="profiles">
          <button
            v-for="p in store.profiles"
            :key="p.id"
            type="button"
            class="profile"
            :disabled="!!spawningId"
            @click="launch(p)"
          >
            <span class="p-name">
              <span class="p-arrow">{{ spawningId === p.id ? '…' : '▸' }}</span>{{ p.name }}
            </span>
            <span class="p-cwd">{{ p.cwd }}</span>
            <span class="p-cmd">$ {{ p.command }}</span>
          </button>
        </div>
      </section>

      <section v-if="recentStopped.length" class="card recent">
        <h3>RECENTLY STOPPED</h3>
        <div v-for="s in recentStopped" :key="s.id" class="r-row">
          <RouterLink :to="`/sessions/${s.id}`" class="r-title">{{ s.title || s.profile_name }}</RouterLink>
          <span class="r-meta">{{ s.cwd_short || s.cwd }} · {{ fmtWhen(s.exited_at) }}</span>
          <button type="button" :disabled="!!spawningId" @click="restart(s)">↻ RESTART</button>
        </div>
      </section>

      <div v-if="setup && setup.complete === false" class="setup-wrap">
        <SetupGuide />
      </div>
    </template>
  </div>
</template>

<style scoped>
.home {
  max-width: 920px;
}

.launch { margin-top: 18px; }
.profiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.profile {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  padding: 12px 14px;
  text-align: left;
  text-transform: none;
  letter-spacing: 0.01em;
  background: var(--bg);
  border-color: var(--line-bright);
}
.profile::before,
.profile::after { content: none; }
.profile:hover {
  background: var(--bg-lift);
  color: var(--cream);
}
.p-name {
  font-size: 16px;
  color: var(--cream);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile:hover .p-name { color: var(--amber); }
.p-arrow {
  display: inline-block;
  width: 18px;
  color: var(--amber-dim);
}
.p-cwd,
.p-cmd {
  padding-left: 18px;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-cwd { color: var(--dim); }
.p-cmd { color: var(--dimmer); }

.recent { margin-top: 22px; }
.setup-wrap { margin-top: 30px; }
.r-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
  flex-wrap: wrap;
}
.r-row:last-child { border-bottom: none; }
.r-title {
  color: var(--bone);
  border-bottom: none;
  font-size: 15px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.r-title:hover { color: var(--amber); }
.r-meta {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--dimmer);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.r-row button { font-size: 12.5px; padding: 4px 10px; }
</style>
