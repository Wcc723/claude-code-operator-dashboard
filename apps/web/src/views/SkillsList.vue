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
    const { items: data } = await api.listSkills();
    items.value = data;
  } finally { loading.value = false; }
}
onMounted(load);

const indexLabel = computed(() => {
  if (loading.value) return '';
  return `INDEX · ${String(items.value.length).padStart(3, '0')} entries`;
});
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與 REFRESH -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">{{ indexLabel || 'LOADING…' }}</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="load" />
  </div>

  <p v-if="loading" class="notice">// scanning .claude/skills …</p>
  <p v-else-if="!items.length" class="notice">// no skills found</p>
  <RouterLink
    v-for="item in items"
    :key="item.slug"
    :to="`/skills/${item.slug}`"
    style="text-decoration: none; color: inherit; border-bottom: none"
  >
    <div class="list-item">
      <div class="row">
        <strong>{{ item.name }}</strong>
        <span class="notice">·  {{ item.slug }}</span>
        <span v-if="item.model" class="chip">.{{ item.model }}</span>
        <span v-if="item.context === 'fork'" class="chip primary">fork</span>
        <span v-if="item['disable-model-invocation']" class="chip">disabled</span>
        <span v-if="item['user-invocable'] === false" class="chip">hidden</span>
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
.spacer { flex: 1; }
</style>
