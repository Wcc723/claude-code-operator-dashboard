<script setup>
// 標記色選擇器：一排色塊 + 「無」。v-model 是 color key（string）或 null。
// 鍵盤：Tab 進到目前選中的那一格，←/→ 移動並選取（radiogroup 慣例）。
import { computed, nextTick, ref } from 'vue';
import { SESSION_COLORS } from '../colors.js';

const props = defineProps({
  modelValue: { type: String, default: null },
  label: { type: String, default: '標記色' },
  size: { type: String, default: 'md' }, // 'sm' | 'md'
  allowNone: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

const options = computed(() => [
  ...(props.allowNone ? [{ key: null, label: '無', hex: null }] : []),
  ...SESSION_COLORS,
]);
const selectedIndex = computed(() => {
  const i = options.value.findIndex((o) => o.key === (props.modelValue || null));
  return i < 0 ? 0 : i;
});

const root = ref(null);

function pick(key) {
  if (props.disabled) return;
  const next = key || null;
  if (next === (props.modelValue || null)) return;
  emit('update:modelValue', next);
  emit('change', next);
}

function onKeydown(e) {
  const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!delta) return;
  e.preventDefault();
  const n = options.value.length;
  const i = (selectedIndex.value + delta + n) % n;
  pick(options.value[i].key);
  nextTick(() => root.value?.querySelectorAll('button')[i]?.focus());
}
</script>

<template>
  <div
    ref="root"
    class="cpick"
    :class="[`sz-${size}`, { disabled }]"
    role="radiogroup"
    :aria-label="label"
    @keydown="onKeydown"
  >
    <button
      v-for="(o, i) in options"
      :key="o.key ?? 'none'"
      type="button"
      class="sw"
      :class="{ on: i === selectedIndex, none: !o.key }"
      role="radio"
      :aria-checked="i === selectedIndex"
      :aria-label="o.key ? `${o.label}色` : '不標色'"
      :title="o.key ? `${o.label}色` : '不標色'"
      :tabindex="i === selectedIndex ? 0 : -1"
      :disabled="disabled"
      :style="o.hex ? { '--sw': o.hex } : null"
      @click="pick(o.key)"
    />
  </div>
</template>

<style scoped>
.cpick {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.cpick.disabled { opacity: 0.5; }
.sw {
  --sw: transparent;
  --d: 18px;
  width: var(--d);
  height: var(--d);
  padding: 0;
  border: 1px solid var(--line-bright);
  border-radius: 50%;
  background: var(--sw);
  cursor: pointer;
  position: relative;
  box-shadow: none;
  text-shadow: none;
  transition: transform 120ms ease-out;
}
.sz-sm .sw { --d: 14px; }
.sw::before,
.sw::after { content: none; }
.sw:hover:not(:disabled) { transform: scale(1.12); }
.sw.on {
  outline: 2px solid var(--cream);
  outline-offset: 2px;
}
.sw:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}
/* 「無」：空心圓 + 斜線 */
.sw.none {
  background:
    linear-gradient(135deg, transparent calc(50% - 1px), var(--dimmer) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px));
}
@media (pointer: coarse) {
  .sw { --d: 26px; }
  .sz-sm .sw { --d: 24px; }
  .cpick { gap: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .sw { transition: none; }
}
</style>
