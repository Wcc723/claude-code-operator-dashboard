<script setup>
import { ref, onMounted, useTemplateRef } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import AgentEditor from '../components/AgentEditor.vue';

const props = defineProps({ slug: { type: String, required: true } });
const resource = ref(null);
const error = ref(null);
const editorRef = useTemplateRef('editor');

onMounted(async () => { resource.value = await api.getAgent(props.slug); });

async function save(payload) {
  error.value = null;
  try {
    resource.value = await api.saveAgent(props.slug, payload);
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      editorRef.value?.showValidationErrors(e.body.errors);
    } else {
      error.value = e.message;
    }
  }
}
</script>

<template>
  <RouterLink to="/station/agents" style="font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase">← back / station / agents</RouterLink>
  <h2 v-if="resource" style="margin-top: 12px">{{ resource.frontmatter.name || resource.slug }}</h2>
  <p v-if="resource" class="section-meta">
    AGENT · {{ resource.slug }} · <code class="path">{{ resource.path }}</code>
  </p>
  <p v-if="error" class="error">{{ error }}</p>
  <AgentEditor v-if="resource" ref="editor" :resource="resource" @save="save" />
</template>
