<script setup>
const props = defineProps({
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['key']);

// 手機鍵盤打不出來、但 Claude Code 常用的按鍵
const KEYS = [
  { label: 'ESC', seq: '\x1b', title: 'Escape' },
  { label: 'TAB', seq: '\t', title: 'Tab' },
  { label: '⇧TAB', seq: '\x1b[Z', title: 'Shift+Tab（切換模式）' },
  { label: '↑', seq: '\x1b[A', title: 'Up' },
  { label: '↓', seq: '\x1b[B', title: 'Down' },
  { label: '←', seq: '\x1b[D', title: 'Left' },
  { label: '→', seq: '\x1b[C', title: 'Right' },
  { label: '⏎', seq: '\r', title: 'Enter' },
  { label: '^C', seq: '\x03', title: 'Ctrl+C', danger: true },
  { label: '1', seq: '1', title: '1' },
  { label: '2', seq: '2', title: '2' },
  { label: '3', seq: '3', title: '3' },
];

// pointerdown 擋掉預設行為 → 不搶 focus、不收起軟鍵盤；
// 真正送出放在 click：橫向滑動捲動按鍵列時瀏覽器會取消 click，不會誤觸
function press(k) {
  if (props.disabled) return;
  emit('key', k.seq);
}
</script>

<template>
  <div class="keybar" role="toolbar" aria-label="終端機按鍵">
    <button
      v-for="k in KEYS"
      :key="k.label"
      type="button"
      class="key"
      :class="{ 'is-danger': k.danger }"
      :title="k.title"
      :aria-label="k.title"
      :disabled="disabled"
      tabindex="-1"
      @pointerdown.prevent
      @mousedown.prevent
      @click="press(k)"
    >{{ k.label }}</button>
  </div>
</template>

<style scoped>
.keybar {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  background: var(--bg-soft);
  border-top: 1px solid var(--line-bright);
}
.keybar::-webkit-scrollbar { display: none; }

.key {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 40px;
  padding: 0 12px;
  font-size: 15px;
  letter-spacing: 0.04em;
  color: var(--bone);
  background: var(--bg);
  border: 1px solid var(--line-bright);
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.key::before,
.key::after { content: none; }
.key:hover,
.key:active {
  color: var(--amber);
  border-color: var(--amber);
  box-shadow: inset 0 0 8px var(--amber-glow);
}
.key:active {
  background: var(--amber);
  color: #000;
}
.key.is-danger {
  color: var(--danger);
  border-color: rgba(255, 112, 88, 0.45);
}
.key.is-danger:active {
  background: var(--danger);
  color: #000;
}
</style>
