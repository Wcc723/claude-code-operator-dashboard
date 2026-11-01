<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import MarkdownView from '../components/MarkdownView.vue';
import RefreshButton from '../components/RefreshButton.vue';

const route = useRoute();
const days = ref([]);
const selected = ref(null);
const loading = ref(true);

async function loadList() {
  loading.value = true;
  const { items } = await api.listMemory();
  days.value = items;
  loading.value = false;
  if (route.params.date) await loadDay(route.params.date);
  else if (items.length) await loadDay(items[0].date);
}

async function loadDay(date) {
  selected.value = await api.getMemory(date);
}

onMounted(loadList);
watch(() => route.params.date, (d) => { if (d) loadDay(d); });

const indexLabel = computed(() => {
  if (loading.value) return '';
  return `JOURNAL · ${String(days.value.length).padStart(3, '0')} days`;
});
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與 REFRESH -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">{{ indexLabel || 'LOADING…' }}</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="loadList" />
  </div>

  <p v-if="loading" class="notice">// scanning memory/ …</p>
  <p v-else-if="!days.length" class="notice">// no memory days</p>
  <div v-else class="memory-grid">
    <div class="memory-rail">
      <div
        v-for="d in days"
        :key="d.date"
        class="day-item"
        :class="{ active: selected?.date === d.date }"
        @click="loadDay(d.date)"
      >
        <strong>{{ d.date }}</strong>
        <div class="meta">{{ Math.round(d.size / 1024 * 10) / 10 }} KB</div>
      </div>
    </div>
    <div v-if="selected" class="memory-content">
      <div class="day-header">
        <span class="prefix">∙ DAY</span>
        <span class="day-num">{{ selected.date }}</span>
      </div>
      <MarkdownView :source="selected.body" />
    </div>
  </div>
</template>

<style scoped>
.memory-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 24px;
}
.memory-rail {
  border-right: 1px dashed var(--line-bright);
  padding-right: 12px;
  max-height: calc(100vh - 180px);
  overflow-y: auto;
}
.day-item {
  padding: 8px 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: all 90ms;
  margin-bottom: 2px;
}
.day-item:hover {
  background: var(--bg-lift);
  border-left-color: var(--amber-dim);
}
.day-item.active {
  background: var(--bg-soft);
  border-left-color: var(--amber);
  color: var(--amber);
}
.day-item.active strong { color: var(--amber); }
.day-item strong {
  color: var(--cream);
  font-size: 16px;
  letter-spacing: 0.04em;
}
.day-item .meta {
  font-size: 15px;
  color: var(--dim);
  margin-top: 4px;
}
.memory-content {
  min-width: 0;
}
.day-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--line-bright);
}
.day-header .prefix {
  font-size: 15px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--dim);
}
.day-header .day-num {
  font-family: var(--display);
  font-size: 26px;
  color: var(--amber);
  letter-spacing: 0.04em;
  text-shadow: 0 0 8px var(--amber-glow);
}
</style>
