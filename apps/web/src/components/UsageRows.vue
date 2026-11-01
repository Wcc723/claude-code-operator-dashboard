<script setup>
// 用量視窗列：label | 10 段 bar（+ 照進度刻度）| 剩餘 %，第二行重置時間點 + 倒數。
// rows 是 lib/usage-format.js 的 usageWindow() 結果（可以先過 dedupeResets 把重複的重置行藏掉）。
// sub：放在外層 grid 裡用 subgrid 對齊欄位（側欄精簡模式讓 Claude / Codex 的 bar 左緣對齊）；
// 不帶就自己是一個 grid（展開浮層裡每個帳號各一組）。
defineProps({
  rows: { type: Array, default: () => [] },
  sub: { type: Boolean, default: false },
});
</script>

<template>
  <div class="u-grid" :class="{ sub }">
    <div
      v-for="w in rows"
      :key="w.key"
      class="u-row"
      :class="w.tone"
      :title="w.title"
    >
      <span class="u-label">{{ w.label }}</span>
      <span class="bar-wrap" aria-hidden="true">
        <span class="bar"><b :style="{ width: w.remaining + '%' }" /></span>
        <i v-if="w.pace != null" class="pace" :style="{ left: w.pace + '%' }" />
      </span>
      <span class="u-pct" :class="`t-${w.pctTone}`">{{ w.pctText }}</span>
      <span v-if="w.paceText" class="sr-only">，{{ w.paceText }}</span>
      <span v-if="!w.hideReset && (w.resetText || w.resetIn)" class="u-reset">
        <span class="u-when">{{ w.resetText }}</span>
        <span v-if="w.resetIn" class="u-in">{{ w.resetIn }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.u-grid {
  display: grid;
  grid-template-columns: auto minmax(28px, 1fr) auto;
  column-gap: 8px;
  row-gap: 7px;
  align-items: center;
}
.u-grid.sub {
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
}
.u-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
  --tone: var(--success);
}
.u-row.warn { --tone: var(--amber); }
.u-row.crit { --tone: var(--danger); }
.u-row.muted { --tone: var(--dimmer); }
.u-row.muted .u-reset { color: var(--dimmer); }

.u-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--dim);
  white-space: nowrap;
}
.u-pct {
  text-align: right;
  min-width: 4ch;
  color: var(--tone);
}
/* 超前用量：剩餘還夠（ok）但用得比進度快，數字改 warn 色；bar 顏色維持剩餘量的語意 */
.u-pct.t-warn { color: var(--amber); }
.u-pct.t-crit { color: var(--danger); }
.u-pct.t-muted { color: var(--dimmer); }

/* 第二行：重置時間點 + 倒數，對齊 bar 的左緣 */
.u-reset {
  grid-column: 2 / -1;
  display: flex;
  gap: 8px;
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--dim);
  white-space: nowrap;
  min-width: 0;
}
.u-when {
  overflow: hidden;
  text-overflow: ellipsis;
}
.u-in {
  margin-left: auto;
  color: var(--dimmer);
}

.bar-wrap {
  position: relative;
  display: block;
  min-width: 0;
}
/* 10 段的平面 bar；用 mask 切段，底色在任何背景上都一致 */
.bar {
  position: relative;
  display: block;
  height: 7px;
  background: var(--line-bright);
  -webkit-mask-image: repeating-linear-gradient(90deg, #000 0 calc(10% - 1px), transparent calc(10% - 1px) 10%);
  mask-image: repeating-linear-gradient(90deg, #000 0 calc(10% - 1px), transparent calc(10% - 1px) 10%);
}
.bar b {
  position: absolute;
  inset: 0 auto 0 0;
  max-width: 100%;
  background: var(--tone);
  transition: width 400ms ease-out;
}
/* 照進度應該剩多少的細刻度：畫在 mask 外面，才不會剛好落在段與段的縫裡被切掉 */
.pace {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: var(--cream);
  box-shadow: 0 0 0 1px var(--bg);
  pointer-events: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .bar b { transition: none; }
}
</style>
