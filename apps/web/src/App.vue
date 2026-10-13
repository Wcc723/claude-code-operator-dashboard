<script setup>
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useSessionsStore, sessionState, STATE_META } from './stores/sessions.js';
import SessionSidebar from './components/SessionSidebar.vue';
import NewSessionButton from './components/NewSessionButton.vue';
import DeviceStatus from './components/DeviceStatus.vue';
import SetupGuide from './components/SetupGuide.vue';

const WORKSPACE = [
  { to: '/identity', label: 'IDENTITY' },
  { to: '/skills', label: 'SKILLS' },
  { to: '/agents', label: 'AGENTS' },
  { to: '/tasks', label: 'TASKS' },
  { to: '/memory', label: 'MEMORY' },
  { to: '/kanban', label: 'KANBAN' },
  { to: '/profiles', label: 'PROFILES' },
  // /sessions/:id 屬於上面的 SESSIONS 區，不算在 WORKSPACE
  { to: '/sessions', label: 'ALL SESSIONS', exact: true },
];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useSessionsStore();

const isLogin = computed(() => route.name === 'login');
const fullBleed = computed(() => !!route.meta.fullBleed);
const mainEl = ref(null);

// ───── WORKSPACE 群組：預設收合、記住開合；目前頁面在裡面時自動展開 ─────
function isIn(item) {
  const p = route.path;
  return item.exact ? p === item.to : p === item.to || p.startsWith(`${item.to}/`);
}
const inWorkspace = computed(() => WORKSPACE.some(isIn));
const workspaceOpen = ref(readFlag('codd.workspaceOpen'));

function readFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function toggleWorkspace() {
  workspaceOpen.value = !workspaceOpen.value;
  try { localStorage.setItem('codd.workspaceOpen', workspaceOpen.value ? '1' : '0'); } catch {}
}
watch(inWorkspace, (inside) => { if (inside) workspaceOpen.value = true; }, { immediate: true });

// ───── 行動版 top bar ─────
const currentSession = computed(() =>
  route.name === 'session' ? store.byId(String(route.params.id)) : null);
const currentState = computed(() => (currentSession.value ? sessionState(currentSession.value) : null));

const pageLabel = computed(() => {
  if (route.name === 'session') return currentSession.value?.title || currentSession.value?.profile_name || 'SESSION';
  if (route.name === 'setup') return 'SETUP';
  const hit = WORKSPACE.find(isIn);
  return hit ? hit.label : 'FANCY/CODD';
});

// ───── 全域行為 ─────
watch(() => auth.user, (user) => {
  if (user) store.start();
  else store.stop();
}, { immediate: true });

watchEffect(() => {
  const n = store.waitingCount;
  document.title = n > 0 ? `(${n}) FANCY/CODD` : 'FANCY/CODD';
});

watch(() => route.path, () => {
  store.setDrawer(false);
  // .main 是內部捲動容器，router 的 scrollBehavior 管不到
  if (mainEl.value) mainEl.value.scrollTop = 0;
});

// Alt+1..9 → 第 n 個 active session。用 e.code：macOS 的 Option+1 會讓 e.key 變成「¡」
function onKeydown(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || isLogin.value) return;
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m) return;
  const target = store.active[Number(m[1]) - 1];
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  if (route.name !== 'session' || route.params.id !== target.id) router.push(`/sessions/${target.id}`);
}

function onEscape(e) {
  if (e.key === 'Escape' && store.drawerOpen) store.setDrawer(false);
}

// api.js 收到 401（cookie 過期 / 被撤銷）：當成登出，停掉 polling 與 stream，回登入頁。
// 同一波 poll 會一次來好幾個 401，第一個把 auth.user 清掉後其餘直接略過
function onUnauthorized() {
  if (!auth.user) return;
  auth.user = null; // watch → store.stop()
  import('./composables/terminalPool.js').then((m) => m.releaseAll()).catch(() => {});
  router.replace({ name: 'login', query: { redirect: route.fullPath } });
}

// --app-h 跟著 visualViewport：iOS 軟鍵盤彈出時 layout viewport 不縮，只有 visual viewport 會縮，
// 所以整個 shell（以及 SessionDetail 底部的輸入列）要自己縮到鍵盤上方
function syncViewport() {
  const rootStyle = document.documentElement.style;
  const vv = window.visualViewport;
  if (!vv) {
    rootStyle.setProperty('--app-h', `${window.innerHeight}px`);
    return;
  }
  // 雙指縮放時不追，否則版面會跟著放大鏡跑
  if (Math.abs(vv.scale - 1) > 0.01) return;
  rootStyle.setProperty('--app-h', `${Math.round(vv.height)}px`);
  rootStyle.setProperty('--app-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
}

const mobileMq = window.matchMedia('(max-width: 767px)');
function onMqChange() {
  if (!mobileMq.matches) store.setDrawer(false);
}

syncViewport();
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('keydown', onEscape);
  window.addEventListener('codd:unauthorized', onUnauthorized);
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  mobileMq.addEventListener?.('change', onMqChange);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('keydown', onEscape);
  window.removeEventListener('codd:unauthorized', onUnauthorized);
  window.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('scroll', syncViewport);
  mobileMq.removeEventListener?.('change', onMqChange);
});

async function logout() {
  store.stop();
  await auth.logout();
  location.href = '/login';
}
</script>

<template>
  <div v-if="isLogin">
    <RouterView />
  </div>
  <div
    v-else-if="auth.user"
    class="app-shell"
    :class="{ 'focus-mode': store.focusMode && fullBleed, 'drawer-open': store.drawerOpen }"
  >
    <header class="mobile-bar">
      <button
        type="button"
        class="mb-menu"
        :aria-label="store.waitingCount ? `開啟選單（${store.waitingCount} 個 session 在等你）` : '開啟選單'"
        :aria-expanded="store.drawerOpen"
        @click="store.setDrawer(!store.drawerOpen)"
      >
        ≡<span v-if="store.waitingCount" class="mb-badge">{{ store.waitingCount }}</span>
      </button>
      <span class="mb-title">{{ pageLabel }}</span>
      <span v-if="currentState" class="mb-state" :class="`st-${currentState}`">
        <span class="mb-lamp">{{ STATE_META[currentState].glyph }}</span>{{ STATE_META[currentState].label }}
      </span>
    </header>

    <div v-if="store.drawerOpen" class="drawer-backdrop" @click="store.setDrawer(false)" />

    <aside class="sidebar">
      <div class="sb-head">
        <RouterLink to="/" class="brand">FANCY/CODD</RouterLink>
        <NewSessionButton />
      </div>

      <div class="sb-scroll">
        <!-- 首頁與 /setup 本身就有完整設定引導；其他頁只放一行提示（完成或關掉後自動消失） -->
        <SetupGuide v-if="route.name !== 'home' && route.name !== 'setup'" compact class="sb-setup" />
        <SessionSidebar />

        <section class="ws">
          <button
            type="button"
            class="ws-toggle"
            :class="{ open: workspaceOpen, inside: inWorkspace }"
            :aria-expanded="workspaceOpen"
            @click="toggleWorkspace"
          >
            <span class="caret">▸</span>WORKSPACE
          </button>
          <nav v-show="workspaceOpen" class="nav">
            <RouterLink
              v-for="item in WORKSPACE"
              :key="item.to"
              :to="item.to"
              :class="{ on: isIn(item) }"
            >{{ item.label }}</RouterLink>
          </nav>
        </section>
      </div>

      <div class="sb-foot">
        <DeviceStatus />
        <div v-if="auth.user" class="account">
          <span class="email" :title="auth.user.email">{{ auth.user.email }}</span>
          <RouterLink to="/setup" class="acct-link" :class="{ on: route.name === 'setup' }">SETUP</RouterLink>
          <button type="button" class="acct-btn" @click="logout">LOGOUT</button>
        </div>
      </div>
    </aside>

    <button
      v-if="store.focusMode && fullBleed"
      type="button"
      class="focus-handle"
      title="顯示側欄"
      aria-label="顯示側欄"
      @click="store.toggleFocusMode()"
    >›</button>

    <main ref="mainEl" class="main" :class="{ 'full-bleed': fullBleed }">
      <RouterView />
    </main>
  </div>
</template>
