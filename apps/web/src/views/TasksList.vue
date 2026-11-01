<script setup>
import { ref, onMounted, computed } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import RefreshButton from '../components/RefreshButton.vue';

const items = ref([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const { items: data } = await api.listTasks();
    items.value = data;
  } finally { loading.value = false; }
}
onMounted(load);

const indexLabel = computed(() => {
  if (loading.value) return '';
  const enabled = items.value.filter(t => t.enabled === true).length;
  return `INDEX · ${String(items.value.length).padStart(3, '0')} entries · ${enabled} active`;
});
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與 REFRESH -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">{{ indexLabel || 'LOADING…' }}</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="load" />
  </div>

  <p v-if="loading" class="notice">// scanning tasks/ …</p>
  <p v-else-if="!items.length" class="notice">// no tasks found</p>
  <RouterLink
    v-for="item in items"
    :key="item.slug"
    :to="`/tasks/${item.slug}`"
    style="text-decoration: none; color: inherit; border-bottom: none"
  >
    <div class="list-item">
      <div class="row">
        <strong>{{ item.name }}</strong>
        <span class="notice">·  {{ item.slug }}</span>
        <span v-if="item.enabled === false" class="chip">disabled</span>
        <span v-else-if="item.enabled === true" class="chip primary">active</span>
        <span v-if="item.channel" class="chip">{{ item.channel }}</span>
      </div>
      <div class="meta">
        <span v-if="item.schedule">cron: <code>{{ item.schedule }}</code></span>
        <span v-else>→ no schedule</span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.chip {
  background: transparent;
  border: 1px solid var(--line-bright);
  color: var(--bone);
  padding: 3px 12px;
  font-size: 15px;
  letter-spacing: 0.08em;
  text-transform: lowercase;
}
.chip.primary {
  background: var(--success);
  border-color: var(--success);
  color: #000;
}
</style>
