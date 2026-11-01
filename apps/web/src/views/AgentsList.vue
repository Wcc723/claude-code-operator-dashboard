<script setup>
import { ref, onMounted, computed } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import RefreshButton from '../components/RefreshButton.vue';

const items = ref([]);
const loading = ref(true);
const now = ref('--:--:--');

async function load() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  now.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  loading.value = true;
  try {
    const { items: data } = await api.listAgents();
    items.value = data;
  } finally { loading.value = false; }
}
onMounted(load);

const COLOR_HEX = {
  red: '#ff5a3c', blue: '#4ed1e6', green: '#5cff8a', yellow: '#ffd84e',
  purple: '#d18cff', orange: '#ff9b4e', pink: '#ff7cb5', cyan: '#4ed1e6',
};

const indexLabel = computed(() => {
  if (loading.value) return '';
  return `INDEX · ${String(items.value.length).padStart(3, '0')} entries · ts:${now.value}`;
});
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與 REFRESH -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">{{ indexLabel || 'LOADING…' }}</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="load" />
  </div>

  <p v-if="loading" class="notice">// scanning .claude/agents …</p>
  <p v-else-if="!items.length" class="notice">// no agents found</p>
  <RouterLink
    v-for="item in items"
    :key="item.slug"
    :to="`/agents/${item.slug}`"
    style="text-decoration: none; color: inherit; border-bottom: none"
  >
    <div class="list-item">
      <div class="row">
        <span
          v-if="item.color"
          class="color-dot"
          :style="{ background: COLOR_HEX[item.color] || item.color }"
        />
        <strong>{{ item.name }}</strong>
        <span class="notice">·  {{ item.slug }}</span>
        <span v-if="item.model" class="chip">.{{ item.model }}</span>
        <span v-if="item.permissionMode" class="chip">perm:{{ item.permissionMode }}</span>
        <span v-if="item.effort" class="chip">effort:{{ item.effort }}</span>
        <span v-if="item.background" class="chip primary">background</span>
        <span v-if="item.isolation" class="chip success">{{ item.isolation }}</span>
      </div>
      <div class="meta">→ {{ item.description || '(沒有描述)' }}</div>
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
.color-dot {
  width: 10px;
  height: 10px;
  display: inline-block;
  box-shadow: 0 0 6px currentColor;
}
.chip {
  background: transparent;
  border: 1px solid var(--line-bright);
  color: var(--bone);
  padding: 3px 12px;
  font-size: 15px;
  letter-spacing: 0.08em;
  text-transform: lowercase;
  font-family: var(--mono);
}
.chip.primary {
  background: var(--amber);
  border-color: var(--amber);
  color: #000;
}
.chip.success {
  border-color: var(--success);
  color: var(--success);
}
</style>
