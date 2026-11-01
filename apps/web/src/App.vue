<script setup>
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useSessionsStore, sessionState, STATE_META } from './stores/sessions.js';
import SessionSidebar from './components/SessionSidebar.vue';
import NewSessionButton from './components/NewSessionButton.vue';
import DeviceStatus from './components/DeviceStatus.vue';
import SetupGuide from './components/SetupGuide.vue';
import { colorHex, colorMeta } from './colors.js';
import { stationTabOf, stationTabLabel } from './station.js';

// 側欄入口（原本的 WORKSPACE 群組）：
// PROJECTS = 開 session 用的設定；STATION = channel 根目錄的 IDENTITY / SKILLS / … 合成一頁（見 station.js）；
// ARTIFACTS = Claude 透過 CODD 的 artifact MCP 發布的 HTML / 畫布。
// ALL SESSIONS 移到 SessionSidebar 的標題列。/station 會 redirect 回上次看的分頁
const NAV = [
  { to: '/projects', label: 'PROJECTS', section: 'projects' },
  { to: '/station', label: 'STATION', section: 'station' },
  { to: '/artifacts', label: 'ARTIFACTS', section: 'artifacts' },
];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useSessionsStore();

const isLogin = computed(() => route.name === 'login');
// /artifact/:id：整頁只有 artifact（沒有側欄、手機 top bar），登入檢查照舊由 router 處理
const standalone = computed(() => !!route.meta.standalone);
const fullBleed = computed(() => !!route.meta.fullBleed);
const mainEl = ref(null);

// STATION 的詳細頁（/skills/:slug …）也算在 STATION 裡（router.js 的 meta.section）
function isIn(item) {
  return route.meta.section === item.section;
}

// ───── 行動版 top bar ─────
const currentSession = computed(() =>
  route.name === 'session' ? store.byId(String(route.params.id)) : null);
const currentState = computed(() => (currentSession.value ? sessionState(currentSession.value) : null));
// session 標記色：標題前的色點（沒標色就不畫）
const currentColor = computed(() => colorHex(currentSession.value?.color));
const currentColorLabel = computed(() => colorMeta(currentSession.value?.color)?.label ?? '');

const pageLabel = computed(() => {
  if (route.name === 'session') return currentSession.value?.title || currentSession.value?.profile_name || 'SESSION';
  if (route.name === 'setup') return 'SETUP';
  if (route.meta.section === 'projects') return 'PROJECTS';
  if (route.meta.section === 'artifacts') return 'ARTIFACTS';
  if (route.meta.section === 'station') {
    const tab = stationTabLabel(stationTabOf(route));
    return tab ? `STATION · ${tab}` : 'STATION';
  }
  if (route.path === '/sessions') return 'ALL SESSIONS';
  return 'FANCY/CODD';
});

// ───── 全域行為 ─────
watch(() => auth.user, (user) => {
  if (user) store.start();
  else store.stop();
}, { immediate: true });

// standalone（artifact 檢視）不疊 CRT 掃描線與暗角：設計稿要看到原本的顏色
watchEffect(() => {
  document.body.classList.toggle('codd-standalone', standalone.value && !!auth.user);
});

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
  <div v-else-if="auth.user && standalone" class="standalone-shell">
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
      <span
        v-if="currentColor"
        class="mb-dot"
        :style="{ '--dot': currentColor }"
        role="img"
        :aria-label="`標記色：${currentColorLabel}`"
      />
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

        <nav class="ws nav" aria-label="主要頁面">
          <RouterLink
            v-for="item in NAV"
            :key="item.to"
            :to="item.to"
            :class="{ on: isIn(item) }"
            :aria-current="isIn(item) ? 'page' : undefined"
          >{{ item.label }}</RouterLink>
        </nav>
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

<style>
/* body::before / ::after 是 styles.css 的 CRT 掃描線與暗角（蓋在整個畫面最上層）；artifact 檢視頁關掉 */
body.codd-standalone::before,
body.codd-standalone::after {
  display: none;
}
</style>

<style scoped>
/* standalone 頁面（/artifact/:id）：跟 .app-shell 一樣固定在 visual viewport 內（--app-h / --app-top），
   iOS 軟鍵盤彈出時整頁縮到鍵盤上方；頁面自己決定內部怎麼捲動 */
.standalone-shell {
  position: fixed;
  left: 0;
  right: 0;
  top: var(--app-top, 0px);
  height: 100vh;
  height: var(--app-h, 100dvh);
  overflow: hidden;
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  display: flex;
  flex-direction: column;
}
.standalone-shell > :deep(*) {
  flex: 1;
  min-height: 0;
}

/* PROJECTS / STATION：沿用 styles.css 的 .ws（上方虛線分隔）與 .nav（連結樣式）；
   .nav 的 padding 會蓋掉 .ws 的 padding-top，這裡補回來 */
.ws.nav {
  padding-top: 8px;
}

/* 行動版 top bar：session 標記色色點（.mobile-bar 的 gap 是 10px，色點要貼近標題） */
.mb-dot {
  flex: none;
  width: 9px;
  height: 9px;
  margin-right: -4px;
  border-radius: 50%;
  background: var(--dot);
  box-shadow: 0 0 6px var(--dot);
}
</style>
