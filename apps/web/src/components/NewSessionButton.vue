<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useSessionsStore } from '../stores/sessions.js';

const store = useSessionsStore();
const router = useRouter();

const open = ref(false);
const spawningId = ref(null);
const error = ref(null);
const root = ref(null);

function toggle() {
  open.value = !open.value;
  error.value = null;
  // 每次打開都重抓：profile 可能剛在 PROFILES 頁改過
  if (open.value) store.loadProfiles();
}

function close() {
  open.value = false;
}

async function pick(p) {
  if (spawningId.value) return;
  spawningId.value = p.id;
  error.value = null;
  try {
    const s = await store.spawn(p.id);
    close();
    store.setDrawer(false);
    router.push(`/sessions/${s.id}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    spawningId.value = null;
  }
}

function onDocPointer(e) {
  if (open.value && root.value && !root.value.contains(e.target)) close();
}

function onKey(e) {
  if (e.key === 'Escape' && open.value) close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="new-session">
    <button
      type="button"
      class="trigger"
      :class="{ on: open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >+ NEW <span class="caret">▾</span></button>

    <div v-if="open" class="menu" role="menu">
      <div class="menu-head">LAUNCH PROFILE</div>
      <p v-if="!store.profiles.length" class="menu-empty">
        // 還沒有 profile<br />
        <RouterLink to="/profiles" @click="close">建立一個 →</RouterLink>
      </p>
      <button
        v-for="p in store.profiles"
        :key="p.id"
        type="button"
        role="menuitem"
        class="item"
        :disabled="!!spawningId"
        @click="pick(p)"
      >
        <span class="name">
          <span class="arrow">{{ spawningId === p.id ? '…' : '▸' }}</span>{{ p.name }}
        </span>
        <span class="cwd">{{ p.cwd }}</span>
      </button>
      <p v-if="error" class="menu-error">{{ error }}</p>
      <div class="menu-foot">
        <RouterLink to="/profiles" @click="close">管理 profiles →</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.new-session {
  position: relative;
  flex: none;
}

.trigger {
  font-size: 12.5px;
  letter-spacing: 0.08em;
  padding: 4px 8px;
  color: var(--amber);
  border-color: var(--amber-dim);
  white-space: nowrap;
}
.trigger::before,
.trigger::after { color: var(--amber-dim); }
.trigger.on,
.trigger:hover {
  background: var(--amber);
  color: #000;
  border-color: var(--amber);
}
.trigger.on::before,
.trigger.on::after,
.trigger:hover::before,
.trigger:hover::after { color: #000; }
.caret { font-size: 10px; }

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: 252px;
  max-width: calc(100vw - 32px);
  max-height: min(60vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg-soft);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(255, 176, 0, 0.08);
  padding: 6px 0;
  animation: menu-in 110ms ease-out;
}
.menu-head {
  padding: 4px 12px 6px;
  font-size: 10.5px;
  letter-spacing: 0.2em;
  color: var(--dim);
  border-bottom: 1px dashed var(--line-bright);
  margin-bottom: 4px;
}

.item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  width: 100%;
  border: none;
  padding: 8px 12px;
  text-align: left;
  text-transform: none;
  letter-spacing: 0.01em;
  min-height: 44px;
}
.item::before,
.item::after { content: none; }
.item:hover,
.item:focus-visible {
  background: var(--bg-lift);
  box-shadow: inset 2px 0 0 var(--amber);
  outline: none;
}
.item:disabled { opacity: 0.5; }
.name {
  font-size: 14px;
  color: var(--cream);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item:hover .name { color: var(--amber); }
.arrow {
  display: inline-block;
  width: 14px;
  color: var(--amber-dim);
}
.cwd {
  padding-left: 14px;
  font-size: 11.5px;
  color: var(--dimmer);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-empty {
  margin: 6px 12px;
  font-size: 13px;
  color: var(--dim);
}
.menu-error {
  margin: 6px 12px;
  font-size: 12px;
  color: var(--danger);
  word-break: break-word;
}
.menu-foot {
  margin-top: 4px;
  padding: 6px 12px 2px;
  border-top: 1px dashed var(--line-bright);
  font-size: 12px;
}
.menu-foot a,
.menu-empty a {
  border-bottom: none;
  color: var(--dim);
  letter-spacing: 0.04em;
}
.menu-foot a:hover,
.menu-empty a:hover { color: var(--amber); }

@keyframes menu-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (pointer: coarse) {
  .trigger { min-height: 40px; padding: 6px 10px; }
}
</style>
