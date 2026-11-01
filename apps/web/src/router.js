import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { STATION_TAB_KEYS, loadStationTab, saveStationTab, stationTabOf } from './station.js';

const StationView = () => import('./views/StationView.vue');
const TAB_PATTERN = STATION_TAB_KEYS.join('|');

// meta.section：側欄哪個入口要亮（App.vue）；meta.tab：STATION 詳細頁屬於哪個分頁
const station = (tab) => ({ section: 'station', tab });

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
  { path: '/setup', name: 'setup', component: () => import('./views/SetupView.vue') },

  // ───── PROJECTS（原 launch profiles）─────
  { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue'), meta: { section: 'projects' } },
  { path: '/profiles', redirect: '/projects' },

  // ───── STATION：列表都在分頁裡；沒帶分頁就回到上次看的那個 ─────
  { path: '/station', redirect: () => `/station/${loadStationTab()}` },
  { path: `/station/:tab(${TAB_PATTERN})`, name: 'station', component: StationView, meta: { section: 'station' } },
  { path: '/station/memory/:date', name: 'station-memory', component: StationView, meta: station('memory') },
  { path: '/station/:pathMatch(.*)*', redirect: '/station' },

  // 詳細頁維持原路徑（外部連結 / 書籤不會斷），返回連結指向 /station/<tab>
  { path: '/identity/:name', component: () => import('./views/IdentityDetail.vue'), props: true, meta: station('identity') },
  { path: '/skills/:slug', component: () => import('./views/SkillDetail.vue'), props: true, meta: station('skills') },
  { path: '/agents/:slug', component: () => import('./views/AgentDetail.vue'), props: true, meta: station('agents') },
  { path: '/tasks/:slug', component: () => import('./views/TaskDetail.vue'), props: true, meta: station('tasks') },

  // 舊的列表網址 → STATION 分頁
  { path: '/identity', redirect: '/station/identity' },
  { path: '/skills', redirect: '/station/skills' },
  { path: '/agents', redirect: '/station/agents' },
  { path: '/tasks', redirect: '/station/tasks' },
  { path: '/memory', redirect: '/station/memory' },
  { path: '/memory/:date', redirect: (to) => ({ name: 'station-memory', params: { date: to.params.date } }) },
  { path: '/kanban', redirect: '/station/kanban' },

  // ───── ARTIFACTS：CODD 托管的 HTML / 畫布 ─────
  // 列表在一般版面；檢視頁是 standalone（App.vue 不畫側欄與手機 top bar，整頁給 artifact）。
  // 對外網址是 /artifact/:id（單數，MCP 回給 Claude 的 url 就是這個）；/artifacts/:id 也導過去
  { path: '/artifacts', name: 'artifacts', component: () => import('./views/ArtifactsList.vue'), meta: { section: 'artifacts' } },
  { path: '/artifact/:id', name: 'artifact', component: () => import('./views/ArtifactView.vue'), props: true, meta: { standalone: true } },
  { path: '/artifacts/:id', redirect: (to) => ({ name: 'artifact', params: { id: to.params.id }, query: to.query }) },
  { path: '/artifact', redirect: '/artifacts' },

  { path: '/sessions', component: () => import('./views/SessionsList.vue') },
  // fullBleed：.main 不留 padding、不捲動，交給 SessionDetail 自己填滿
  { path: '/sessions/:id', name: 'session', component: () => import('./views/SessionDetail.vue'), props: true, meta: { fullBleed: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (auth.loading) await auth.hydrate();
  if (!to.meta.public && !auth.user) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.user) return '/';
});

// 記住最後看的 STATION 分頁（含詳細頁：看完某個 skill 再點側欄 STATION，回到 SKILLS）
router.afterEach((to, from, failure) => {
  if (failure) return;
  const tab = stationTabOf(to);
  if (tab) saveStationTab(tab);
});

export default router;
