<script setup>
// 畫布上的說明卡：Claude 寫給使用者的唯讀文字（canvas spec 的 notes）。
// 文字一律用插值（不用 v-html），保留換行。位置由 x / y（世界座標）決定，CanvasBoard 只負責放進 world 層。
// data-selectable：滑鼠在卡片上拖曳是選字，不會平移畫布；觸控仍可拖著平移。
import { computed } from 'vue';

const props = defineProps({
  note: { type: Object, required: true },
});

const COLORS = {
  yellow: '#f2d64b',
  pink: '#ff7ac6',
  blue: '#5aa9ff',
  green: '#5fd38a',
  purple: '#b48cff',
  gray: '#a8a298',
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const style = computed(() => ({
  left: `${num(props.note.x, 0)}px`,
  top: `${num(props.note.y, 0)}px`,
  width: `${Math.max(120, num(props.note.width, 360))}px`,
  '--c': COLORS[props.note.color] || COLORS.yellow,
}));
</script>

<template>
  <aside class="cnote" data-world-item data-selectable :style="style" aria-label="Claude 的說明">
    <div class="cnote-tag" aria-hidden="true">CLAUDE · 說明</div>
    <p class="cnote-text">{{ note.text }}</p>
  </aside>
</template>

<style scoped>
.cnote {
  position: absolute;
  padding: 12px 16px 14px;
  background:
    linear-gradient(to right, var(--c) 0 3px, transparent 3px),
    linear-gradient(rgba(10, 10, 10, 0.94), rgba(10, 10, 10, 0.94)),
    var(--c);
  border: 1px solid var(--line-bright);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  color: var(--cream);
  font-family: var(--cjk);
  font-size: 15px;
  line-height: 1.6;
  letter-spacing: 0.02em;
  user-select: text;
}
.cnote-tag {
  margin-bottom: 6px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--c);
}
.cnote-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
