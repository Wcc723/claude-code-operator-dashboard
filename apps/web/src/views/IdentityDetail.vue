<script setup>
import { ref, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import MarkdownView from '../components/MarkdownView.vue';

const props = defineProps({ name: { type: String, required: true } });
const resource = ref(null);
const error = ref(null);
const editMode = ref(false);
const body = ref('');
const saving = ref(false);

async function load() {
  resource.value = await api.getIdentity(props.name);
  body.value = resource.value?.body ?? '';
  editMode.value = false;
  error.value = null;
}
onMounted(load);
watch(() => props.name, load);

async function save() {
  error.value = null;
  saving.value = true;
  try {
    const updated = await api.saveIdentity(props.name, {
      body: body.value,
      expectedMtime: resource.value.mtime,
    });
    resource.value = updated;
    body.value = updated.body;
    editMode.value = false;
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <RouterLink to="/station/identity" style="font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase">← back / station / identity</RouterLink>
  <h2 v-if="resource" style="margin-top: 12px">{{ resource.name }}</h2>
  <p v-if="resource" class="section-meta">
    IDENTITY · {{ resource.name }} · <code class="path">{{ resource.path }}</code>
  </p>

  <div v-if="resource" class="editor-shell">
    <div class="toolbar">
      <button @click="editMode = !editMode">{{ editMode ? '取消編輯' : '✏️ 編輯' }}</button>
      <button v-if="editMode" class="primary" :disabled="saving" @click="save">💾 儲存</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="editMode">
      <div class="card">
        <h3 style="margin-top: 0">Body (Markdown)</h3>
        <textarea v-model="body" style="min-height: 560px" />
      </div>
    </template>
    <template v-else>
      <MarkdownView :source="body" />
    </template>
  </div>
</template>
