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
    const { items: data } = await api.listIdentity();
    items.value = data;
  } finally { loading.value = false; }
}
onMounted(load);

const indexLabel = computed(() => {
  if (loading.value) return '';
  return `INDEX · ${String(items.value.length).padStart(3, '0')} files`;
});

function formatMtime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與 REFRESH -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">{{ indexLabel || 'LOADING…' }}</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="load" />
  </div>

  <p v-if="loading" class="notice">// scanning channel root …</p>
  <p v-else-if="!items.length" class="notice">// no identity files found</p>
  <RouterLink
    v-for="item in items"
    :key="item.name"
    :to="`/identity/${item.name}`"
    style="text-decoration: none; color: inherit; border-bottom: none"
  >
    <div class="list-item">
      <div class="row">
        <strong>{{ item.name }}</strong>
        <span class="chip">{{ Math.round(item.size / 1024 * 10) / 10 }} KB</span>
        <span class="chip">{{ formatMtime(item.mtime) }}</span>
      </div>
      <div class="meta">→ {{ describe(item.name) }}</div>
    </div>
  </RouterLink>
</template>

<script>
function describe(name) {
  const map = {
    'CLAUDE.md': 'channel 啟動流程 / 排程規則 / 任務規格',
    'IDENTITY.md': 'AI 角色設定（人格 / 特質）',
    'SOUL.md': '語調規則（說話風格 / 禁用詞）',
    'USER.md': '使用者資料（時區 / 技棧 / 偏好）',
    'MEMORY.md': '長期記憶（跨 session 累積）',
  };
  return map[name] || '';
}
</script>

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
  letter-spacing: 0.04em;
  font-family: var(--mono);
}
</style>
