<script setup>
// STATION：IDENTITY / SKILLS / AGENTS / TASKS / MEMORY / KANBAN 合成一頁，上方分頁列切換。
// 分頁就是路由（/station/:tab），所以重新整理、上一頁、分享連結都會停在同一個分頁；
// 下面直接渲染原本的列表元件（各自載資料、各自的 REFRESH），切分頁時才載入該分頁的程式碼。
import { computed, defineAsyncComponent, h, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { STATION_TABS, DEFAULT_STATION_TAB, stationTabOf, stationTabLabel } from '../station.js';

const Loading = { render: () => h('p', { class: 'notice' }, '// loading …') };
const LoadFailed = { render: () => h('p', { class: 'error' }, '分頁載入失敗（可能剛更新過版本），重新整理頁面再試一次') };

function lazy(loader) {
  return defineAsyncComponent({ loader, loadingComponent: Loading, errorComponent: LoadFailed, delay: 150 });
}

const PANELS = {
  identity: lazy(() => import('./IdentityList.vue')),
  skills: lazy(() => import('./SkillsList.vue')),
  agents: lazy(() => import('./AgentsList.vue')),
  tasks: lazy(() => import('./TasksList.vue')),
  memory: lazy(() => import('./MemoryViewer.vue')),
  kanban: lazy(() => import('./KanbanBoard.vue')),
};

const route = useRoute();
const tab = computed(() => stationTabOf(route) || DEFAULT_STATION_TAB);
const panel = computed(() => PANELS[tab.value]);

// 手機上分頁列會橫向捲動：直接開 /station/kanban 這種後面的分頁時，把目前分頁捲進看得到的地方。
// 只動分頁列自己的 scrollLeft（不用 scrollIntoView，免得連 .main 的直向位置一起捲）
const tabsEl = ref(null);
function revealActiveTab() {
  const tabs = tabsEl.value;
  const on = tabs?.querySelector('.st-tab.on');
  if (!tabs || !on || tabs.scrollWidth <= tabs.clientWidth) return;
  const a = tabs.getBoundingClientRect();
  const b = on.getBoundingClientRect();
  if (b.left >= a.left && b.right <= a.right) return;
  tabs.scrollLeft += (b.left + b.width / 2) - (a.left + a.width / 2);
}
onMounted(() => {
  revealActiveTab();
  // 字型（Google Fonts display=swap）換上來之後分頁會變寬，再對一次
  document.fonts?.ready.then(revealActiveTab);
});
watch(tab, () => nextTick(revealActiveTab));
</script>

<template>
  <div class="station">
    <header class="st-head">
      <h2 class="st-title">STATION</h2>
      <nav ref="tabsEl" class="st-tabs" aria-label="STATION 分頁">
        <RouterLink
          v-for="t in STATION_TABS"
          :key="t.key"
          :to="`/station/${t.key}`"
          class="st-tab"
          :class="{ on: t.key === tab }"
          :aria-current="t.key === tab ? 'page' : undefined"
        >{{ t.label }}</RouterLink>
      </nav>
    </header>

    <section class="st-panel" :aria-label="stationTabLabel(tab)">
      <component :is="panel" :key="tab" />
    </section>
  </div>
</template>

<style scoped>
.st-head {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin-bottom: 22px;
  border-bottom: 1px dashed var(--line-bright);
}
.st-title {
  margin: 0 0 6px;
}

.st-tabs {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 2px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  /* 讓底線壓在 header 的虛線上 */
  margin-bottom: -1px;
}
.st-tabs::-webkit-scrollbar { display: none; }

.st-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 6px 12px;
  border-bottom: 2px solid transparent;
  color: var(--dim);
  font-size: 13.5px;
  letter-spacing: 0.14em;
  white-space: nowrap;
  transition: color 100ms, border-color 100ms;
}
.st-tab:hover {
  color: var(--cream);
  border-bottom-color: var(--line-bright);
}
.st-tab.on {
  color: var(--amber);
  border-bottom-color: var(--amber);
  text-shadow: 0 0 6px var(--amber-glow);
  background: linear-gradient(0deg, var(--amber-glow) 0%, transparent 70%);
}
.st-tab:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: -2px;
}

.st-panel {
  min-width: 0;
}

@media (max-width: 767px) {
  .st-head {
    flex-direction: column;
    /* column + wrap 會讓每一行撐到子項的 max-content，分頁列被拉寬、自己的 overflow-x 捲不動 */
    flex-wrap: nowrap;
    align-items: stretch;
    margin-bottom: 18px;
  }
  /* 手機上 mobile bar 已經寫了 STATION · <分頁>，大標題收掉，分頁列頂到最上面 */
  .st-title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .st-tabs {
    margin-left: -16px;
    margin-right: -16px;
    padding: 0 10px;
  }
  .st-tab {
    padding: 6px 10px;
    font-size: 13px;
    letter-spacing: 0.1em;
  }
}

@media (prefers-reduced-motion: reduce) {
  .st-tab { transition: none; }
}
</style>
