<script setup>
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import ResourceEditor from '../components/ResourceEditor.vue';

const props = defineProps({ slug: { type: String, required: true } });
const resource = ref(null);
const error = ref(null);

onMounted(async () => { resource.value = await api.getTask(props.slug); });

async function save(payload) {
  try { resource.value = await api.saveTask(props.slug, payload); }
  catch (e) { error.value = e.message; }
}
</script>

<template>
  <RouterLink to="/station/tasks" style="font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase">← back / station / tasks</RouterLink>
  <h2 v-if="resource" style="margin-top: 12px">{{ resource.frontmatter.name || resource.slug }}</h2>
  <p v-if="resource" class="section-meta">
    TASK · {{ resource.slug }} · <code class="path">{{ resource.path }}</code>
  </p>
  <p class="notice">// editing does not restart cron — next claude code session will re-scan</p>
  <p v-if="error" class="error">{{ error }}</p>
  <ResourceEditor v-if="resource" :resource="resource" @save="save" />
</template>
