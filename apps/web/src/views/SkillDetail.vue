<script setup>
import { ref, onMounted, useTemplateRef } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import SkillEditor from '../components/SkillEditor.vue';
import SkillFiles from '../components/SkillFiles.vue';

const props = defineProps({ slug: { type: String, required: true } });
const resource = ref(null);
const error = ref(null);
const editorRef = useTemplateRef('editor');

async function load() {
  resource.value = await api.getSkill(props.slug);
}
onMounted(load);

async function save(payload) {
  error.value = null;
  try {
    const updated = await api.saveSkill(props.slug, payload);
    resource.value = updated;
    if (updated.warnings?.length) {
      editorRef.value?.showWarnings(updated.warnings);
    }
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
  <RouterLink to="/station/skills" style="font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase">← back / station / skills</RouterLink>
  <h2 v-if="resource" style="margin-top: 12px">{{ resource.frontmatter.name || resource.slug }}</h2>
  <p v-if="resource" class="section-meta">
    SKILL · {{ resource.slug }} · <code class="path">{{ resource.path }}</code>
  </p>
  <p v-if="error" class="error">{{ error }}</p>
  <SkillEditor v-if="resource" ref="editor" :resource="resource" @save="save" />
  <SkillFiles v-if="resource" :slug="resource.slug" />
</template>
