<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import draggable from 'vuedraggable';
import { useSessionsStore, sessionState, STATE_META } from '../stores/sessions.js';

const STOPPED_LIMIT = 12;
// claude 開起來超過這麼久還沒有任何 hook 回報，才提示（SessionStart 正常幾秒內就會到）
const NO_HOOK_AFTER_SEC = 20;

const store = useSessionsStore();
const route = useRoute();
const router = useRouter();

const currentId = computed(() => (route.name === 'session' ? String(route.params.id) : null));

// 1 秒 tick 只為了「在此狀態多久」的秒數；分鐘以上的顯示其實 5 秒刷一次就夠
const now = ref(Date.now());
let clock = null;

const stoppedOpen = ref(readStoppedOpen());
function readStoppedOpen() {
  try { return localStorage.getItem('codd.stoppedOpen') === '1'; } catch { return false; }
}

// 正在看的 session 已結束（剛 KILL、或從 ALL SESSIONS 點進來）：STOPPED 暫時展開讓它的列看得到（不寫回偏好）
const currentStopped = computed(() => (currentId.value ? store.stopped.find((s) => s.id === currentId.value) ?? null : null));
const forceOpen = ref(false);
watch(() => currentStopped.value?.id ?? null, (id) => { forceOpen.value = !!id; }, { immediate: true });
const stoppedVisible = computed(() => stoppedOpen.value || forceOpen.value);

function toggleStopped() {
  stoppedOpen.value = !stoppedVisible.value;
  forceOpen.value = false;
  try { localStorage.setItem('codd.stoppedOpen', stoppedOpen.value ? '1' : '0'); } catch {}
}

const stoppedShown = computed(() => {
  const list = store.stopped.slice(0, STOPPED_LIMIT);
  const cur = currentStopped.value;
  if (cur && !list.includes(cur)) list.push(cur);
  return list;
});
const stoppedMore = computed(() => Math.max(0, store.stopped.length - stoppedShown.value.length));

function secsSince(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.value - t) / 1000));
}

function fmtDur(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

function fmtClock(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now.value);
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 保留尾巴：~/Github/a/b/c → ~/…/b/c（最後兩層最能辨識專案）
function shortPath(s) {
  const p = s.cwd_short || s.cwd || '';
  const parts = p.split('/');
  const head = parts[0] === '' ? '' : parts[0];
  if (parts.length <= 4) return p;
  return `${head}/…/${parts.slice(-2).join('/')}`;
}

function titleOf(s) {
  return s.title || s.profile_name || s.id.slice(0, 8);
}

function stateOf(s) {
  return sessionState(s);
}

function inStateFor(s) {
  return fmtDur(secsSince(s.activity?.since));
}

function uptimeOf(s) {
  return fmtDur(secsSince(s.started_at));
}

function isClaudeCmd(s) {
  return Boolean(s.claude_session_id) || /^\s*(\S*\/)?claude(\s|$)/.test(s.command || '');
}

// hook_seen === false（舊版 server 是 undefined，不提示）
function noHook(s) {
  if (s.status !== 'running' || s.hook_seen !== false || !isClaudeCmd(s)) return false;
  const up = secsSince(s.started_at);
  return up != null && up >= NO_HOOK_AFTER_SEC;
}
const NO_HOOK_TITLE = '沒收到這個 session 的 hook 回報，標題、狀態和最近 prompt 不會更新。'
  + '可能是 hook 安裝前就開的（重開即可），或 hook 沒裝在 claude 讀的設定檔（到 SETUP 檢查）';

function reasonText(s) {
  const r = s.activity?.reason;
  return r ? { permission: '權限確認', question: '回答問題', plan: '確認計畫' }[r] ?? r : '';
}


async function removeStopped(s) {
  try {
    await store.remove(s.id);
    if (currentId.value === s.id) router.replace('/');
  } catch (e) {
    store.error = e.message;
  }
}

function onRowClick() {
  store.setDrawer(false);
}

// ───── 拖曳排序 ─────
// 桌機：整列都能拖（移動超過 4px 才算拖，單純點擊照常切換）；觸控：只能從左側把手拖，避免跟捲動搶手勢
const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const dragging = ref(false);
// 放開滑鼠時瀏覽器會補一個 click 給游標下的連結（通常就是剛拖的那列），要擋掉免得拖完就跳頁。
// vuedraggable 的 start / end 都延到 nextTick 才發，click 可能比 end 早到：拖曳期間一律擋，結束後再多擋一下
let dragActive = false;
let dragEndedAt = 0;
const CLICK_GUARD_MS = 300;

function onDragStart() {
  dragActive = true;
  dragging.value = true;
  hidePop();
}

function onDragEnd() {
  dragActive = false;
  dragEndedAt = Date.now();
  dragging.value = false;
}

function swallowClickAfterDrag(e) {
  if (!dragActive && Date.now() - dragEndedAt > CLICK_GUARD_MS) return;
  e.preventDefault();
  e.stopPropagation();
}

function onReorder(list) {
  store.reorder(list.map((s) => s.id));
}

// 鍵盤：Alt+Shift+↑/↓ 移動目前聚焦的那列
async function moveBy(s, delta) {
  const ids = store.active.map((x) => x.id);
  const from = ids.indexOf(s.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  const done = store.reorder(ids);
  await nextTick();
  // keyed 列表重排會搬動 DOM 節點，焦點會掉，補回去
  document.querySelector(`.srow[data-sid="${s.id}"]`)?.focus();
  await done;
}

// ───── hover popover（只在有滑鼠的裝置；觸控裝置沒有 hover） ─────
const canHover = typeof window !== 'undefined'
  && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
const pop = ref(null);           // { id, top, left }
const popEl = ref(null);
let popTimer = null;

const popSession = computed(() => (pop.value ? store.byId(pop.value.id) : null));
// 位置要跟著拖曳 / 鍵盤移動即時更新（Alt+n 的 n）
const popIdx = computed(() => (pop.value ? store.active.findIndex((x) => x.id === pop.value.id) : -1));

function showPop(e, s) {
  if (!canHover || dragging.value) return;
  clearTimeout(popTimer);
  const el = e.currentTarget;
  popTimer = setTimeout(async () => {
    const r = el.getBoundingClientRect();
    pop.value = { id: s.id, top: r.top, left: r.right + 10 };
    await nextTick();
    const box = popEl.value?.getBoundingClientRect();
    if (box && pop.value && box.bottom > window.innerHeight - 8) {
      pop.value = { ...pop.value, top: Math.max(8, window.innerHeight - 8 - box.height) };
    }
  }, pop.value ? 60 : 380);
}

function hidePop() {
  clearTimeout(popTimer);
  popTimer = null;
  pop.value = null;
}

// 鍵盤 Tab 到列上也看得到 popover（滑鼠點擊造成的 focus 不算）
function onRowFocus(e, s) {
  if (e.currentTarget.matches?.(':focus-visible')) showPop(e, s);
  else hidePop();
}

watch(() => route.fullPath, hidePop);

onMounted(() => {
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
  window.addEventListener('scroll', hidePop, true);
});
onUnmounted(() => {
  clearInterval(clock);
  window.removeEventListener('scroll', hidePop, true);
  hidePop();
});
</script>

<template>
  <section class="sessions" aria-label="Sessions">
    <header class="sec-head">
      <span class="sec-label">SESSIONS</span>
      <span class="sec-count">{{ store.active.length }}</span>
      <span class="spacer" />
      <span v-if="store.waitingCount" class="sec-waiting" :title="`${store.waitingCount} 個 session 在等你`">
        ◆ {{ store.waitingCount }}
      </span>
    </header>

    <div v-if="!store.loaded" class="skeleton" aria-hidden="true">
      <div v-for="n in 3" :key="n" class="sk-row">
        <span class="sk-bar w70" />
        <span class="sk-bar w45" />
      </div>
    </div>

    <template v-else>
      <p v-if="store.error && !store.items.length" class="empty err">// {{ store.error }}</p>
      <p v-else-if="!store.active.length" class="empty">
        // 沒有執行中的 session<br />
        <span class="dimmer">按上方 + NEW 開一個</span>
      </p>

      <draggable
        v-else
        tag="ul"
        class="rows"
        :class="{ 'is-dragging': dragging }"
        role="list"
        :model-value="store.active"
        item-key="id"
        :animation="150"
        :force-fallback="true"
        :fallback-tolerance="4"
        :handle="coarse ? '.grip' : null"
        ghost-class="drag-ghost"
        chosen-class="drag-chosen"
        drag-class="drag-float"
        @start="onDragStart"
        @end="onDragEnd"
        @update:model-value="onReorder"
      >
        <template #item="{ element: s }">
          <li class="active-item" @click.capture="swallowClickAfterDrag">
            <span class="grip" aria-hidden="true" title="拖曳調整順序">⠿</span>
            <RouterLink
              :to="`/sessions/${s.id}`"
              class="srow"
              :class="[`st-${stateOf(s)}`, { current: currentId === s.id }]"
              :data-sid="s.id"
              :aria-current="currentId === s.id ? 'page' : undefined"
              :aria-keyshortcuts="'Alt+Shift+ArrowUp Alt+Shift+ArrowDown'"
              draggable="false"
              @click="onRowClick"
              @mouseenter="showPop($event, s)"
              @mouseleave="hidePop"
              @focus="onRowFocus($event, s)"
              @blur="hidePop"
              @keydown.alt.shift.up.prevent="moveBy(s, -1)"
              @keydown.alt.shift.down.prevent="moveBy(s, 1)"
            >
              <span class="line1">
                <span class="lamp" aria-hidden="true">{{ STATE_META[stateOf(s)].glyph }}</span>
                <span class="title">{{ titleOf(s) }}</span>
                <span class="state" :aria-hidden="stateOf(s) === 'unknown' ? 'true' : undefined">{{ STATE_META[stateOf(s)].label }}</span>
                <span v-if="stateOf(s) === 'unknown'" class="sr-only">UNKNOWN</span>
              </span>
              <span v-if="s.last_prompt" class="sr-only">最近 prompt：{{ s.last_prompt }}</span>
              <span class="line2">
                <span class="cwd"><span dir="ltr">{{ shortPath(s) }}</span></span>
                <span class="times">
                  <span v-if="noHook(s)" class="no-hook" :title="NO_HOOK_TITLE">⚠ NO HOOK</span>
                  <span v-if="noHook(s)" class="sep">·</span>
                  <span v-if="inStateFor(s)" class="t-state">{{ inStateFor(s) }}</span>
                  <span v-if="inStateFor(s)" class="sep">·</span>
                  <span class="t-up">{{ uptimeOf(s) }}</span>
                </span>
              </span>
              <span v-if="noHook(s)" class="sr-only">{{ NO_HOOK_TITLE }}</span>
            </RouterLink>
          </li>
        </template>
      </draggable>

      <div v-if="store.stopped.length" class="stopped">
        <button class="toggle" type="button" :aria-expanded="stoppedVisible" @click="toggleStopped">
          <span class="caret" :class="{ open: stoppedVisible }">▸</span>
          STOPPED <span class="dimmer">({{ store.stopped.length }})</span>
        </button>
        <ul v-if="stoppedVisible" class="rows" role="list">
          <li v-for="s in stoppedShown" :key="s.id" class="stopped-item">
            <RouterLink
              :to="`/sessions/${s.id}`"
              class="srow st-ended has-rm"
              :class="{ current: currentId === s.id }"
              :aria-current="currentId === s.id ? 'page' : undefined"
              @click="onRowClick"
            >
              <span class="line1">
                <span class="lamp" aria-hidden="true">✕</span>
                <span class="title">{{ titleOf(s) }}</span>
              </span>
              <span class="line2">
                <span class="cwd"><span dir="ltr">{{ shortPath(s) }}</span></span>
                <span class="times"><span class="t-up">{{ fmtClock(s.exited_at) }}</span></span>
              </span>
            </RouterLink>
            <button
              class="rm"
              type="button"
              title="從列表移除"
              :aria-label="`移除 ${titleOf(s)}`"
              @click="removeStopped(s)"
            >✕</button>
          </li>
          <li v-if="stoppedMore" class="more">
            <RouterLink to="/sessions" @click="onRowClick">+{{ stoppedMore }} more → ALL SESSIONS</RouterLink>
          </li>
        </ul>
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="pop && popSession"
        ref="popEl"
        class="sess-pop"
        :class="`st-${stateOf(popSession)}`"
        :style="{ top: `${pop.top}px`, left: `${pop.left}px` }"
        role="tooltip"
      >
        <div class="pop-state">
          <span class="lamp">{{ STATE_META[stateOf(popSession)].glyph }}</span>
          {{ STATE_META[stateOf(popSession)].label }}
          <template v-if="reasonText(popSession)"> · {{ reasonText(popSession) }}</template>
          <template v-if="inStateFor(popSession)"> · {{ inStateFor(popSession) }}</template>
        </div>
        <div class="pop-title">{{ titleOf(popSession) }}</div>
        <div v-if="popSession.last_prompt" class="pop-prompt">
          <span class="k">最近 prompt：</span>{{ popSession.last_prompt }}
        </div>
        <div v-else-if="noHook(popSession)" class="pop-warn">⚠ {{ NO_HOOK_TITLE }}</div>
        <div class="pop-path">{{ popSession.cwd || popSession.cwd_short }}</div>
        <div class="pop-meta">
          <span v-if="popSession.profile_name">{{ popSession.profile_name }}</span>
          <span v-if="popSession.activity?.last_tool">tool {{ popSession.activity.last_tool }}</span>
          <span v-if="popSession.context_left_pct != null">ctx {{ Math.round(popSession.context_left_pct) }}%</span>
          <span>up {{ uptimeOf(popSession) }}</span>
          <span v-if="popIdx >= 0 && popIdx < 9" class="kbd">Alt+{{ popIdx + 1 }}</span>
        </div>
        <div class="pop-hint">拖曳或 Alt+Shift+↑↓ 調整順序</div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.sessions {
  --st-color: var(--bone);
  display: flex;
  flex-direction: column;
}

.sec-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px 8px;
  font-size: 11.5px;
  letter-spacing: 0.18em;
  color: var(--dim);
}
.sec-count {
  color: var(--amber-dim);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.sec-waiting {
  color: #000;
  background: var(--amber);
  padding: 0 6px;
  font-size: 11px;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 10px var(--amber-glow);
}
.spacer { flex: 1; }

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ───── 拖曳排序 ───── */
.active-item { position: relative; }
.grip {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: 0;
  width: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--dim);
  opacity: 0;
  pointer-events: none;
  user-select: none;
  transition: opacity 90ms;
}
@media (hover: hover) {
  .active-item:hover .grip { opacity: 0.7; }
  .rows.is-dragging .active-item:hover .grip { opacity: 0; }
}
/* 原位置留一個虛線框，表示放下去會落在哪 */
.drag-ghost > .srow {
  background: var(--bg-soft);
  border: 1px dashed var(--amber-dim);
  border-left-width: 2px;
}
.drag-ghost > .srow > *,
.drag-ghost > .grip { visibility: hidden; }
/* 跟著游標 / 手指走的那份 */
.drag-float {
  opacity: 0.95 !important;
  background: var(--bg-lift);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-bright);
}
.drag-float .grip { opacity: 0.9; }
.rows.is-dragging .srow { cursor: grabbing; }
.active-item > .srow { -webkit-user-select: none; user-select: none; }

/* ───── Row ───── */
.srow {
  --st-color: var(--bone);
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 8px 7px 10px;
  color: var(--bone);
  border: none;
  border-left: 2px solid transparent;
  text-decoration: none;
  position: relative;
  transition: background 90ms, border-color 90ms;
  min-height: 44px;
  justify-content: center;
}
.srow:hover {
  color: var(--bone);
  background: var(--bg-soft);
  border-left-color: var(--line-bright);
}
.srow:focus-visible {
  outline: 1px solid var(--amber-dim);
  outline-offset: -1px;
}
.srow.current {
  background: var(--bg-lift);
  border-left-color: var(--amber);
}
.srow.current .title { color: var(--cream); }

.line1,
.line2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.lamp {
  flex: 0 0 12px;
  width: 12px;
  text-align: center;
  font-size: 11px;
  line-height: 1;
  color: var(--st-color);
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 1.45;
  color: var(--bone);
  letter-spacing: 0.01em;
}
.state {
  flex: none;
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.14em;
  color: var(--st-color);
  padding: 0 4px;
  border: 1px solid transparent;
}

.line2 {
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--dimmer);
}
/* RTL 容器讓溢出從左邊截掉，路徑尾巴（專案名）永遠看得到；內層 dir=ltr 保持字元順序 */
.cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  color: var(--dim);
}
.times {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  letter-spacing: 0;
}
.t-state { color: var(--st-color); }
.sep { color: var(--dimmer); margin: 0 3px; }
.t-up { color: var(--dimmer); }
.no-hook {
  color: var(--amber-dim);
  letter-spacing: 0.06em;
  font-size: 10.5px;
}

/* ───── State colours ───── */
.st-waiting { --st-color: var(--amber); }
.st-busy { --st-color: var(--success); }
.st-idle { --st-color: var(--cyan); }
.st-unknown { --st-color: var(--bone); }
.st-ended { --st-color: var(--dimmer); }

.st-busy .lamp { text-shadow: 0 0 6px rgba(124, 255, 154, 0.55); }
.st-idle .t-state { color: var(--dim); }
.st-unknown .lamp { opacity: 0.6; }

.srow.st-waiting {
  background: linear-gradient(90deg, rgba(255, 184, 74, 0.09) 0%, rgba(255, 184, 74, 0.02) 100%);
  border-left-color: var(--amber);
}
.srow.st-waiting:hover { background: rgba(255, 184, 74, 0.13); }
.srow.st-waiting.current { background: rgba(255, 184, 74, 0.16); }
.srow.st-waiting .title { color: var(--cream); }
.srow.st-waiting .lamp {
  font-size: 12px;
  animation: lamp-pulse 1.1s ease-in-out infinite;
}
.srow.st-waiting .state {
  color: #000;
  background: var(--amber);
  border-color: var(--amber);
  font-weight: 700;
  box-shadow: 0 0 8px var(--amber-glow);
}

.srow.st-ended .title { color: var(--dim); }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.srow.st-ended .lamp { font-size: 10px; }

@keyframes lamp-pulse {
  0%, 100% { opacity: 1; text-shadow: 0 0 10px var(--amber), 0 0 2px var(--amber); }
  50% { opacity: 0.3; text-shadow: none; }
}
@media (prefers-reduced-motion: reduce) {
  .srow.st-waiting .lamp { animation: none; }
}

/* ───── Stopped ───── */
.stopped { margin-top: 10px; }
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  padding: 6px 4px;
  font-size: 11.5px;
  letter-spacing: 0.18em;
  color: var(--dim);
  text-align: left;
  min-height: 32px;
}
.toggle::before,
.toggle::after,
.rm::before,
.rm::after { content: none; }
.toggle:hover {
  color: var(--cream);
  box-shadow: none;
}
.caret {
  display: inline-block;
  transition: transform 120ms;
  color: var(--dimmer);
}
.caret.open { transform: rotate(90deg); }

.stopped-item { position: relative; }
.srow.has-rm { padding-right: 36px; }
.rm {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  font-size: 12px;
  color: var(--dimmer);
  letter-spacing: 0;
  opacity: 0.55;
}
.stopped-item:hover .rm,
.rm:focus-visible { opacity: 1; }
.rm:hover {
  color: var(--danger);
  border-color: var(--danger);
  box-shadow: none;
}
.more { padding: 6px 4px 2px 30px; font-size: 12px; }
.more a { border-bottom: none; color: var(--dim); letter-spacing: 0.06em; }
.more a:hover { color: var(--amber); }

/* ───── Empty / skeleton ───── */
.empty {
  margin: 4px 4px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dim);
}
.empty.err { color: var(--danger); }
.dimmer { color: var(--dimmer); }

.sk-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 10px 10px 30px;
}
.sk-bar {
  display: block;
  height: 9px;
  background: linear-gradient(90deg, var(--bg-lift) 0%, var(--line-bright) 50%, var(--bg-lift) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
}
.sk-bar.w70 { width: 70%; }
.sk-bar.w45 { width: 45%; opacity: 0.6; }
@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

/* ───── Touch: 至少 40px 高的點擊區 ───── */
@media (pointer: coarse) {
  .srow { min-height: 52px; }
  /* 觸控只能從把手拖：把手常駐、夠寬，並且不讓瀏覽器把這個手勢當捲動 */
  .grip {
    width: 30px;
    font-size: 15px;
    opacity: 0.55;
    pointer-events: auto;
    touch-action: none;
    -webkit-touch-callout: none;
  }
  .active-item > .srow { padding-left: 32px; }
  .toggle { min-height: 40px; }
  .rm { width: 40px; height: 40px; opacity: 0.8; }
  .srow.has-rm { padding-right: 48px; }
}

/* ───── Popover（teleport 到 body，scoped 仍適用） ───── */
.sess-pop {
  position: fixed;
  z-index: 200;
  width: 340px;
  max-width: calc(100vw - 300px);
  padding: 10px 12px 9px;
  background: var(--bg-soft);
  border: 1px solid var(--line-bright);
  border-left: 2px solid var(--st-color);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.6);
  font-size: 13px;
  line-height: 1.55;
  color: var(--bone);
  pointer-events: none;
  animation: pop-in 120ms ease-out;
}
.pop-state {
  font-size: 10.5px;
  letter-spacing: 0.14em;
  color: var(--st-color);
  margin-bottom: 4px;
}
.pop-state .lamp { display: inline; font-size: 10px; margin-right: 2px; }
.pop-title {
  color: var(--cream);
  font-size: 14px;
  word-break: break-word;
}
.pop-prompt {
  margin-top: 8px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px dashed var(--line-bright);
  color: var(--bone);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pop-prompt .k { color: var(--amber-dim); }
.pop-warn {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--amber-dim);
  color: var(--amber);
  font-size: 12px;
  line-height: 1.5;
}
.pop-hint {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--dimmer);
  letter-spacing: 0.04em;
}
.pop-path {
  margin-top: 8px;
  font-size: 12px;
  color: var(--dim);
  word-break: break-all;
}
.pop-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--dimmer);
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}
.pop-meta .kbd {
  margin-left: auto;
  color: var(--dim);
  border: 1px solid var(--line-bright);
  padding: 0 5px;
}
@keyframes pop-in {
  from { opacity: 0; transform: translateX(-3px); }
  to { opacity: 1; transform: translateX(0); }
}
</style>
