<script>
// 收到 payload 的本機時間；放 module 層，元件重掛（手機 drawer 開關）時不會把舊資料誤判成剛收到
const seenAt = new WeakMap();
</script>

<script setup>
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue';
import { useSessionsStore } from '../stores/sessions.js';
import { clamp, duration, fmt0, fmt1, num, pct, relTime } from '../lib/usage-format.js';
import UsagePanel from './UsagePanel.vue';

const store = useSessionsStore();
const sys = computed(() => store.system);

const now = ref(Date.now());
const receivedAt = ref(0);

watch(sys, (v) => {
  const raw = v ? toRaw(v) : null;
  if (raw && !seenAt.has(raw)) seenAt.set(raw, Date.now());
  receivedAt.value = raw ? seenAt.get(raw) : 0;
  now.value = Date.now();
}, { immediate: true });

// 「x 分鐘前」每 30 秒自己走，不重新抓資料
let ticker = null;
function tick() { now.value = Date.now(); }
function onVisible() { if (!document.hidden) tick(); }
onMounted(() => {
  ticker = setInterval(tick, 30000);
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisible);
});

// 格式化 helper（%、相對時間、duration）跟用量面板共用：見 lib/usage-format.js
const GIB = 1024 ** 3;

function gib(bytes) {
  const g = bytes / GIB;
  return g >= 10 ? fmt0(g) : fmt1(g);
}
function size(bytes) {
  if (bytes >= 1024 * GIB) return `${fmt1(bytes / (1024 * GIB))}T`;
  return `${gib(bytes)}G`;
}

// ── HOST ─────────────────────────────────────────────
const sysAge = computed(() => (receivedAt.value ? Math.max(0, (now.value - receivedAt.value) / 1000) : 0));
const sysStale = computed(() => sysAge.value > 60);

const uptimeText = computed(() => {
  const s = num(sys.value?.uptime_sec);
  return s == null ? '' : `up ${duration(s)}`;
});

const cpu = computed(() => {
  const c = sys.value?.cpu;
  const p = num(c?.percent);
  const load = Array.isArray(sys.value?.load) ? sys.value.load.map((x) => fmt1(x)).join(' ') : null;
  const parts = [];
  if (load) parts.push(`load ${load}`);
  if (num(c?.cores)) parts.push(`${c.cores} cores`);
  return {
    text: p == null ? '…' : pct(p),
    fill: p == null ? 0 : clamp(p),
    title: parts.join(' · '),
  };
});

const PRESSURE = { normal: 'ok', warn: 'warn', critical: 'crit' };
const mem = computed(() => {
  const m = sys.value?.memory;
  const total = num(m?.total_bytes);
  const used = num(m?.used_bytes);
  if (!total || used == null) return null;
  const detail = [
    ['app', m.app_bytes], ['wired', m.wired_bytes], ['compressed', m.compressed_bytes], ['cached', m.cached_bytes],
  ].filter(([, v]) => num(v) != null).map(([k, v]) => `${k} ${size(v)}`);
  if (m.pressure) detail.push(`pressure ${m.pressure}`);
  return {
    text: `${gib(used)}/${gib(total)}G`,
    fill: clamp((used / total) * 100),
    tone: PRESSURE[m.pressure] ?? null,
    title: detail.join(' · '),
  };
});

const swap = computed(() => {
  const s = sys.value?.memory?.swap;
  const used = num(s?.used_bytes);
  if (!used || used <= 0) return null;
  const total = num(s.total_bytes);
  return { text: size(used), title: total ? `swap ${size(used)} / ${size(total)}` : '' };
});

const disk = computed(() => {
  const d = sys.value?.disk;
  const avail = num(d?.avail_bytes);
  if (avail == null) return null;
  const used = num(d.used_percent);
  let tone = null;
  if (used != null && used >= 95) tone = 'crit';
  else if (used != null && used >= 85) tone = 'warn';
  return {
    text: `${size(avail)} free`,
    fill: used == null ? 0 : clamp(used),
    tone,
    title: [used != null ? `used ${fmt1(used)}%` : null, num(d.total_bytes) ? `total ${size(d.total_bytes)}` : null]
      .filter(Boolean).join(' · '),
  };
});

const battery = computed(() => {
  const b = sys.value?.battery;
  const p = num(b?.percent);
  if (!b || p == null) return null;
  const onAc = b.source === 'ac';
  let tone = null;
  if (!onAc && !b.charging && p <= 10) tone = 'crit';
  else if (!onAc && !b.charging && p <= 20) tone = 'warn';
  return {
    text: `${fmt0(p)}%${b.charging ? ' ⚡' : onAc ? ' AC' : ''}`,
    fill: clamp(p),
    tone,
    title: b.charging ? '充電中' : onAc ? '接上電源' : '使用電池',
  };
});
</script>

<template>
  <section class="ds" aria-label="主機狀態與用量">
    <div v-if="!sys" class="skeleton" aria-busy="true" aria-label="載入中">
      <div class="sk-head"><i class="sk w30" /><i class="sk w20" /></div>
      <div class="grid">
        <div v-for="n in 4" :key="n" class="cell"><i class="sk w70" /><i class="sk meter-sk" /></div>
      </div>
    </div>

    <template v-else>
      <div class="head">
        <span class="tag">HOST</span>
        <span v-if="sysStale" class="fresh stale" title="主機資料沒有更新">{{ relTime(sysAge) }}</span>
        <span v-else class="fresh">{{ uptimeText }}</span>
      </div>
      <div class="grid" :class="{ stale: sysStale }">
        <div class="cell" :title="cpu.title">
          <span class="k">CPU</span>
          <span class="v">{{ cpu.text }}</span>
          <i class="meter"><b :style="{ width: cpu.fill + '%' }" /></i>
        </div>
        <div v-if="mem" class="cell" :class="mem.tone" :title="mem.title">
          <span class="k">MEM</span>
          <span class="v"><span v-if="mem.tone" class="lamp" aria-hidden="true">●</span>{{ mem.text }}</span>
          <i class="meter"><b :style="{ width: mem.fill + '%' }" /></i>
        </div>
        <div v-if="disk" class="cell" :class="disk.tone" :title="disk.title">
          <span class="k">DISK</span>
          <span class="v">{{ disk.text }}</span>
          <i class="meter"><b :style="{ width: disk.fill + '%' }" /></i>
        </div>
        <div v-if="swap" class="cell" :title="swap.title">
          <span class="k">SWAP</span>
          <span class="v">{{ swap.text }}</span>
        </div>
        <div v-if="battery" class="cell" :class="battery.tone" :title="battery.title">
          <span class="k">BAT</span>
          <span class="v">{{ battery.text }}</span>
          <i class="meter"><b :style="{ width: battery.fill + '%' }" /></i>
        </div>
      </div>
    </template>

    <!-- 用量（Claude / Codex 帳號）：資料來源跟 HOST 無關，HOST 還在載入時也照樣顯示 -->
    <UsagePanel />
  </section>
</template>

<style scoped>
.ds {
  container-type: inline-size;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.35;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--bone);
  text-transform: none;
  /* 矮視窗（手機橫向、矮的分割視窗）：側欄底部（.sb-foot）是 flex:none、.sidebar 又是 overflow:hidden，
     HOST + USAGE 太高會把上面的 session 列表擠到 0、把 SETUP / LOGOUT 擠出畫面。
     上限 = 視窗高 - 300px（留給側欄標頭、session 列表與帳號列），超過就在這一塊裡自己捲；一般高度放得下，不受影響。
     padding / 負 margin：留一點邊，focus 外框不會被捲動區裁掉 */
  max-height: max(96px, calc(var(--app-h, 100dvh) - 300px));
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: -3px -4px;
  padding: 3px 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-bright) transparent;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 5px;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--dim);
}
.tag { color: var(--amber-dim); }
.tag-sub {
  font-family: var(--cjk);
  letter-spacing: 0.08em;
  color: var(--dimmer);
}
.fresh {
  margin-left: auto;
  letter-spacing: 0.04em;
  color: var(--dimmer);
  white-space: nowrap;
}
.fresh.stale { color: var(--amber-dim); }

/* ── HOST grid ── */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  transition: opacity 200ms;
}
.cell {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 6px;
  align-items: baseline;
  min-width: 0;
}
.k {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--dim);
}
.v {
  text-align: right;
  color: var(--cream);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.lamp {
  margin-right: 4px;
  font-size: 9px;
  vertical-align: 1px;
}
.meter {
  grid-column: 1 / -1;
  display: block;
  height: 2px;
  margin-top: 3px;
  background: var(--line-bright);
  position: relative;
}
.meter b {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--amber-dim);
  max-width: 100%;
}
.cell.ok .lamp { color: var(--success); text-shadow: 0 0 6px rgba(124, 255, 154, 0.5); }
.cell.warn .lamp,
.cell.warn .v { color: var(--amber); }
.cell.warn .meter b { background: var(--amber); }
.cell.crit .lamp,
.cell.crit .v { color: var(--danger); }
.cell.crit .meter b { background: var(--danger); }
.cell.ok .v { color: var(--cream); }

.grid.stale { opacity: 0.5; filter: grayscale(1); }

/* ── skeleton ── */
.sk-head { display: flex; justify-content: space-between; margin-bottom: 7px; }
.sk {
  display: block;
  height: 9px;
  background: var(--line-bright);
  animation: sk-pulse 1.4s ease-in-out infinite;
}
.sk.w20 { width: 22%; }
.sk.w30 { width: 32%; }
.sk.w70 { grid-column: 1 / -1; width: 70%; }
.sk.meter-sk { grid-column: 1 / -1; height: 2px; margin-top: 4px; }
@keyframes sk-pulse {
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}

/* 太窄（例如縮小的 drawer）就改單欄 */
@container (max-width: 200px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
