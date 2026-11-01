<script setup>
import { ref, onMounted, computed } from 'vue';
import draggable from 'vuedraggable';
import { api } from '../api.js';
import RefreshButton from '../components/RefreshButton.vue';

const columns = ref([]);
const cards = ref([]);
const loading = ref(true);
const showModal = ref(false);
const editingCard = ref(null);
const formTitle = ref('');
const formDescription = ref('');
const formColumnId = ref(null);
const formTags = ref('');
const error = ref(null);

const cardsByColumn = computed(() => {
  const map = {};
  for (const col of columns.value) map[col.id] = [];
  for (const card of cards.value) {
    if (map[card.column_id]) map[card.column_id].push(card);
  }
  return map;
});

async function load() {
  const [cols, cs] = await Promise.all([api.listColumns(), api.listCards()]);
  columns.value = cols.items;
  cards.value = cs.items;
  loading.value = false;
}

onMounted(load);

function openCreate(columnId) {
  editingCard.value = null;
  formTitle.value = '';
  formDescription.value = '';
  formColumnId.value = columnId ?? columns.value[0]?.id;
  formTags.value = '';
  error.value = null;
  showModal.value = true;
}

function openEdit(card) {
  editingCard.value = card;
  formTitle.value = card.title;
  formDescription.value = card.description ?? '';
  formColumnId.value = card.column_id;
  formTags.value = (card.tags ?? []).join(', ');
  error.value = null;
  showModal.value = true;
}

async function submitForm() {
  error.value = null;
  const tags = formTags.value.split(',').map(t => t.trim()).filter(Boolean);
  try {
    if (editingCard.value) {
      await api.updateCard(editingCard.value.id, {
        title: formTitle.value,
        description: formDescription.value,
        columnId: formColumnId.value,
        tags,
      });
    } else {
      await api.createCard({
        title: formTitle.value,
        description: formDescription.value,
        columnId: formColumnId.value,
        tags,
      });
    }
    showModal.value = false;
    await load();
  } catch (e) { error.value = e.message; }
}

async function deleteCard() {
  if (!editingCard.value) return;
  if (!confirm(`刪除「${editingCard.value.title}」？`)) return;
  await api.deleteCard(editingCard.value.id);
  showModal.value = false;
  await load();
}

async function onDrop(columnId) {
  const list = cardsByColumn.value[columnId];
  for (let i = 0; i < list.length; i++) {
    const card = list[i];
    if (card.column_id !== columnId || card.position !== i) {
      await api.updateCard(card.id, { columnId, position: i });
    }
  }
  await load();
}
</script>

<template>
  <!-- 大標題由 STATION 的分頁列負責；這裡只留索引列與動作 -->
  <div class="toolbar">
    <p class="section-meta" style="margin: 0">BOARD · {{ cards.length }} cards</p>
    <span class="spacer" />
    <RefreshButton :on-refresh="load" />
    <button class="primary" @click="openCreate()">+ NEW</button>
  </div>
  <p v-if="loading" class="notice">// loading …</p>
  <div v-else class="kanban-board">
    <div v-for="col in columns" :key="col.id" class="kanban-column">
      <h3>{{ col.name }} <span class="notice">({{ cardsByColumn[col.id]?.length || 0 }})</span></h3>
      <draggable
        :list="cardsByColumn[col.id]"
        :group="{ name: 'cards' }"
        item-key="id"
        @end="onDrop(col.id)"
      >
        <template #item="{ element }">
          <div class="kanban-card" @click="openEdit(element)">
            <div><strong>{{ element.title }}</strong></div>
            <div v-if="element.description" class="meta" style="margin-top: 4px; white-space: pre-wrap">{{ element.description.slice(0, 80) }}{{ element.description.length > 80 ? '…' : '' }}</div>
            <div v-if="element.tags?.length" class="tags">
              <span v-for="t in element.tags" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
        </template>
      </draggable>
    </div>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h3>{{ editingCard ? '編輯卡片' : '新增卡片' }}</h3>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="row">
        <label>標題</label>
        <input v-model="formTitle" placeholder="標題" />
      </div>
      <div class="row">
        <label>描述 (markdown)</label>
        <textarea v-model="formDescription" rows="5" />
      </div>
      <div class="row">
        <label>欄位</label>
        <select v-model="formColumnId">
          <option v-for="col in columns" :key="col.id" :value="col.id">{{ col.name }}</option>
        </select>
      </div>
      <div class="row">
        <label>標籤 (用逗號分隔)</label>
        <input v-model="formTags" placeholder="urgent, design, ..." />
      </div>
      <div class="actions">
        <button v-if="editingCard" class="danger" @click="deleteCard">🗑 刪除</button>
        <span style="flex: 1" />
        <button @click="showModal = false">取消</button>
        <button class="primary" :disabled="!formTitle" @click="submitForm">儲存</button>
      </div>
    </div>
  </div>
</template>
