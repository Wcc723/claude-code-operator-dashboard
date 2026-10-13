<script setup>
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useSessionsStore } from '../stores/sessions.js';

const store = useSessionsStore();
const sys = computed(() => store.system);
const usage = computed(() => sys.value?.usage ?? null);

// 收到 payload 的本機時間；用 module 層 WeakMap，元件重掛（手機 drawer 開關）時不會把舊資料誤判成剛收到
const seenAt = new WeakMap();
const now = ref(Date.now());
const receivedAt = ref(0);

watch(sys, (v) => {
  const raw = v ? toRaw(v) : null;
  if (raw && !seenAt.has(raw)) seenAt.set(raw, Date.now());
  receivedAt.value = raw ? seenAt.get(raw) : 0;
  now.value = Date.now();
}, { immediate: true });

// 倒數與「x 分鐘前」每 30 秒自己走，不重新抓資料
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

const GIB = 1024 ** 3;
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const weekdayFmt = new Intl.DateTimeFormat('zh-TW', { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

function num(n) { return Number.isFinite(n) ? n : null; }
function gib(bytes) {
  const g = bytes / GIB;
  return g >= 10 ? nf0.format(g) : nf1.format(g);
}
function size(bytes) {
  if (bytes >= 1024 * GIB) return `${nf1.format(bytes / (1024 * GIB))}T`;
  return `${gib(bytes)}G`;
}
function pct(n) { return `${nf0.format(n)}%`; }
function clamp(n) { return Math.max(0, Math.min(100, n)); }
function pad2(n) { return String(n).padStart(2, '0'); }

function relTime(sec) {
  if (sec == null) return '';
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${pad2(m)}m`;
  return `${m}m`;
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
  const load = Array.isArray(sys.value?.load) ? sys.value.load.map((x) => nf1.format(x)).join(' ') : null;
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
    title: [used != null ? `used ${nf1.format(used)}%` : null, num(d.total_bytes) ? `total ${size(d.total_bytes)}` : null]
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
    text: `${nf0.format(p)}%${b.charging ? ' ⚡' : onAc ? ' AC' : ''}`,
    fill: clamp(p),
    tone,
    title: b.charging ? '充電中' : onAc ? '接上電源' : '使用電池',
  };
});

// ── USAGE ────────────────────────────────────────────
// server 算 age 時的時間點 + 本機經過的秒數；不用 captured_at 直接減，避開手機與主機的時鐘差
const usageAge = computed(() => {
  const a = num(usage.value?.age_seconds);
  if (a == null) return null;
  const extra = receivedAt.value ? Math.max(0, (now.value - receivedAt.value) / 1000) : 0;
  return a + extra;
});
const usageStale = computed(() => usageAge.value != null && usageAge.value > 1800);

// 重置的時間點：今天只寫時間；明天寫「明天」；再更久寫日期 + 星期（1w 視窗最遠接近 7 天，光寫星期幾會跟今天撞名）
function resetWhen(resetMs) {
  const d = new Date(resetMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = d.toDateString();
  if (day === new Date(now.value).toDateString()) return hm;
  if (day === new Date(now.value + 86400000).toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${weekdayFmt.format(d)} ${hm}`;
}

function resetIn(resetMs) {
  return `${duration(Math.ceil(Math.max(0, resetMs - now.value) / 60000) * 60)}後`;
}

function windowRow(key, label, w) {
  // 還沒收到這個視窗的資料也列出來，看得出有這一項、只是在等回報
  if (!w) {
    return {
      key,
      label,
      remaining: 0,
      tone: 'muted',
      pctText: '—',
      resetText: '等待回報',
      resetIn: '',
      title: `${label} 視窗還沒有資料：Claude Code 回報用量後才會出現（只有訂閱方案會回報）`,
    };
  }
  const resetMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
  const passed = Boolean(w.reset_passed) || (Number.isFinite(resetMs) && resetMs <= now.value);
  const used = passed ? 0 : num(w.used_percentage) ?? 0;
  const remaining = passed ? 100 : clamp(num(w.remaining_percentage) ?? 100 - used);
  let tone = 'ok';
  if (remaining < 20) tone = 'crit';
  else if (remaining < 50) tone = 'warn';
  const when = Number.isFinite(resetMs) ? fullFmt.format(new Date(resetMs)) : null;
  return {
    key,
    label,
    remaining,
    tone: passed ? 'muted' : tone,
    pctText: pct(remaining),
    resetText: passed ? '已重置' : Number.isFinite(resetMs) ? `重置 ${resetWhen(resetMs)}` : '',
    resetIn: !passed && Number.isFinite(resetMs) ? resetIn(resetMs) : '',
    title: passed
      ? `${label} 視窗已過重置時間，額度視為 100%（等下一次回報更新）`
      : `${label} 視窗：已用 ${nf1.format(used)}%，剩 ${nf1.format(remaining)}%${when ? `，${when} 重置` : ''}`,
  };
}

const windows = computed(() => {
  const u = usage.value;
  if (!u) return [];
  return [
    windowRow('5h', '5h', u.five_hour),
    windowRow('1w', '1w', u.seven_day),
  ];
});
</script>

<template>
  <section class="ds" aria-label="主機狀態與用量">
    <div v-if="!sys" class="skeleton" aria-busy="true" aria-label="載入中">
      <div class="sk-head"><i class="sk w30" /><i class="sk w20" /></div>
      <div class="grid">
        <div v-for="n in 4" :key="n" class="cell"><i class="sk w70" /><i class="sk meter-sk" /></div>
      </div>
      <div class="sk-head"><i class="sk w30" /><i class="sk w20" /></div>
      <div v-for="n in 2" :key="'u' + n" class="sk-bar"><i class="sk" /><i class="sk grow" /><i class="sk" /></div>
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

      <div v-if="usage" class="usage" :class="{ stale: usageStale }">
        <div class="head">
          <span class="tag">USAGE <span class="tag-sub">剩餘</span></span>
          <span v-if="usage.config_key && usage.config_key !== 'default'" class="acct">{{ usage.config_key }}</span>
          <span class="fresh" :class="{ stale: usageStale }" :title="usageStale ? '超過 30 分鐘沒有新的用量資料' : '最近一次收到用量資料'">{{ relTime(usageAge) }}</span>
        </div>
        <div class="u-grid">
          <div v-for="w in windows" :key="w.key" class="u-row" :class="w.tone" :title="w.title">
            <span class="u-label">{{ w.label }}</span>
            <span class="bar" aria-hidden="true"><b :style="{ width: w.remaining + '%' }" /></span>
            <span class="u-pct">{{ w.pctText }}</span>
            <span class="u-reset">
              <span class="u-when">{{ w.resetText }}</span>
              <span v-if="w.resetIn" class="u-in">{{ w.resetIn }}</span>
            </span>
          </div>
        </div>
      </div>
      <RouterLink v-else to="/setup" class="setup-link">
        <span class="u-label">5h/1w</span> 用量尚未接上 <span class="go">設定 →</span>
      </RouterLink>
    </template>
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
.acct {
  color: var(--cyan);
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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

.grid.stale,
.usage.stale { opacity: 0.5; filter: grayscale(1); }

/* ── USAGE ── */
.usage {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.u-grid {
  display: grid;
  grid-template-columns: auto minmax(28px, 1fr) auto;
  column-gap: 8px;
  row-gap: 7px;
  align-items: center;
}
.u-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
}
.u-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--dim);
}
.u-pct {
  text-align: right;
  color: var(--tone);
  min-width: 4ch;
}
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
.u-row { --tone: var(--success); }
.u-row.warn { --tone: var(--amber); }
.u-row.crit { --tone: var(--danger); }
.u-row.muted { --tone: var(--dimmer); }
.u-row.muted .u-reset { color: var(--dimmer); }

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

/* ── 未接上 ── */
.ds .setup-link,
.ds .setup-link:hover {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 0 0;
  border: none;
  border-top: 1px dashed var(--line);
  background: none;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  text-transform: none;
  text-shadow: none;
  color: var(--dim);
}
.ds .setup-link::before,
.ds .setup-link::after { content: none; display: none; }
@media (pointer: coarse) {
  .ds .setup-link,
  .ds .setup-link:hover { min-height: 40px; align-items: center; }
}
.ds .setup-link .go { color: var(--amber); margin-left: auto; }
.ds .setup-link:hover .go { color: var(--cream); }

/* ── skeleton ── */
.skeleton .grid { margin-bottom: 10px; }
.sk-head { display: flex; justify-content: space-between; margin-bottom: 7px; }
.sk-bar {
  display: grid;
  grid-template-columns: 18px 1fr 34px;
  gap: 8px;
  margin-bottom: 6px;
}
.sk {
  display: block;
  height: 9px;
  background: var(--line-bright);
  animation: sk-pulse 1.4s ease-in-out infinite;
}
.sk.w20 { width: 22%; }
.sk.w30 { width: 32%; }
.sk.w70 { grid-column: 1 / -1; width: 70%; }
.sk.grow { width: 100%; height: 7px; align-self: center; }
.sk.meter-sk { grid-column: 1 / -1; height: 2px; margin-top: 4px; }
@keyframes sk-pulse {
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
  .bar b { transition: none; }
}

/* 太窄（例如縮小的 drawer）就改單欄 */
@container (max-width: 200px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
