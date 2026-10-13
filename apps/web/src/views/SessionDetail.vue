<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { api } from '../api.js';
import { useSessionsStore } from '../stores/sessions.js';
import * as pool from '../composables/terminalPool.js';
import TerminalPane from '../components/TerminalPane.vue';
import KeyBar from '../components/KeyBar.vue';
import Composer from '../components/Composer.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();
const store = useSessionsStore();

const COMPOSER_KEY = 'codd.composer';
// Claude Code 收到「文字 + \r」同一包時會把 \r 當成貼上內容；Enter 要隔一小段時間另外送
const SUBMIT_DELAY_MS = 60;

const STATE_META = {
  waiting: { icon: '◆', label: 'WAITING' },
  busy: { icon: '●', label: 'BUSY' },
  idle: { icon: '○', label: 'IDLE' },
  unknown: { icon: '●', label: '—' },
  ended: { icon: '✕', label: 'EXITED' },
};
const REASON_LABEL = { permission: 'PERMISSION', question: 'QUESTION', plan: 'PLAN' };

const coarse = pool.isCoarsePointer();

function sessionState(s) {
  if (!s) return 'unknown';
  if (s.status && s.status !== 'running') return 'ended';
  const st = s.activity?.state;
  return st && st in STATE_META ? st : 'unknown';
}

const session = computed(() => store.byId(props.id));
// TerminalPane 回報的 { id, state }；只採用目前這個 session 的
const termInfo = shallowRef(null);
const termState = computed(() => (termInfo.value?.id === props.id ? termInfo.value.state : null));
const exited = computed(() => session.value?.status === 'exited' || !!termState.value?.exited);
const state = computed(() => (exited.value ? 'ended' : sessionState(session.value)));
const meta = computed(() => STATE_META[state.value] ?? STATE_META.unknown);

const title = computed(() =>
  session.value?.title || session.value?.profile_name || `session ${props.id.slice(0, 8)}`);
const lastPrompt = computed(() => session.value?.last_prompt || '');

// 路徑太長時保留最後兩層（專案資料夾才是辨識重點），完整路徑在 popover；手機一律用短版
function shortenPath(c, max) {
  if (c.length <= max) return c;
  const segs = c.split('/').filter(Boolean);
  if (segs.length <= 3) return c;
  return `${c.startsWith('~') ? '~' : ''}/…/${segs.slice(-2).join('/')}`;
}
const cwdLabel = computed(() => shortenPath(session.value?.cwd_short || '', 60));
const cwdTail = computed(() => shortenPath(session.value?.cwd_short || '', 24));

// ───── 時間顯示 ─────
const now = ref(Date.now());
let clock = null;

function ms(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function fmtDur(delta) {
  if (delta == null || delta < 0) return '';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

const chipText = computed(() => {
  const s = session.value;
  const parts = [`${meta.value.icon} ${meta.value.label}`];
  if (state.value === 'waiting' && REASON_LABEL[s?.activity?.reason]) parts.push(REASON_LABEL[s.activity.reason]);
  const since = state.value === 'ended' ? ms(s?.exited_at) : ms(s?.activity?.since);
  if (since != null) parts.push(fmtDur(now.value - since));
  return parts.join(' · ');
});

const uptime = computed(() => {
  const s = session.value;
  const start = ms(s?.started_at);
  if (start == null) return '';
  const end = exited.value ? (ms(s?.exited_at) ?? now.value) : now.value;
  return `${exited.value ? 'RAN' : 'UP'} ${fmtDur(end - start)}`;
});

const ctxPct = computed(() => {
  const v = session.value?.context_left_pct;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
});

const exitCode = computed(() => session.value?.exit_code ?? termState.value?.exitInfo?.exitCode ?? null);
// server 被訊號終止時存成 'signal:15'
const exitText = computed(() => {
  const c = exitCode.value;
  if (c == null) return '';
  const sig = typeof c === 'string' && /^signal:(.+)$/.exec(c);
  return sig ? `signal ${sig[1]}` : `code ${c}`;
});

// ───── 最近 prompt popover（桌面 hover、觸控點一下） ─────
const promptOpen = ref(false);
function identEnter() { if (!coarse) promptOpen.value = true; }
function identLeave() { if (!coarse) promptOpen.value = false; }
function identTap() { if (coarse) promptOpen.value = !promptOpen.value; }
// 鍵盤：標題是可 focus 的按鈕，Tab 進來（focus-visible）就打開、Enter / Space 切換、離開就關
function titleFocus(e) { if (!coarse && e.target.matches?.(':focus-visible')) promptOpen.value = true; }
function titleBlur() { if (!coarse) promptOpen.value = false; }
function titleActivate(e) {
  // 觸控交給 .ident 的 identTap；滑鼠點擊時 hover 已經開著，只處理鍵盤觸發的 click（detail = 0）
  if (coarse || e.detail !== 0) return;
  promptOpen.value = !promptOpen.value;
}

// ───── 字級 / 專注模式 / composer ─────
const fontSize = computed(() => pool.termPrefs.fontSize);
function fontStep(delta) { pool.setFontSize(fontSize.value + delta); }

function loadComposerPref() {
  try {
    const v = localStorage.getItem(COMPOSER_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {}
  return coarse;
}
const composerOn = ref(loadComposerPref());
function toggleComposer() {
  composerOn.value = !composerOn.value;
  try { localStorage.setItem(COMPOSER_KEY, composerOn.value ? '1' : '0'); } catch {}
}
// 觸控裝置沒有實體 Esc / 方向鍵：KeyBar 永遠在；桌面跟著 composer 一起開關
const showKeyBar = computed(() => !exited.value && (composerOn.value || coarse));
const showComposer = computed(() => !exited.value && composerOn.value);

// ───── ⋯ menu ─────
const menuOpen = ref(false);
const menuRef = ref(null);
function onDocPointerDown(e) {
  if (menuOpen.value && menuRef.value && !menuRef.value.contains(e.target)) menuOpen.value = false;
  if (promptOpen.value && coarse && !e.target.closest?.('.ident')) promptOpen.value = false;
}
function onDocKeydown(e) {
  if (e.key === 'Escape' && menuOpen.value) menuOpen.value = false;
  if (e.key === 'Escape' && promptOpen.value) promptOpen.value = false;
}

// ───── 動作 ─────
const busyAction = ref('');
const actionError = ref('');

async function run(name, fn) {
  if (busyAction.value) return;
  busyAction.value = name;
  actionError.value = '';
  menuOpen.value = false;
  try {
    await fn();
  } catch (e) {
    actionError.value = e?.message || `${name} failed`;
  } finally {
    busyAction.value = '';
  }
}

function restart() {
  return run('restart', async () => {
    const oldId = props.id;
    const fresh = await store.restart(oldId);
    if (!fresh?.id) return;
    await router.replace(`/sessions/${fresh.id}`);
    // 舊的已經結束：讓出 pool 的位置
    pool.release(oldId);
  });
}

function kill() {
  if (!confirm('Kill this session?')) return;
  return run('kill', () => store.kill(props.id));
}

function remove() {
  if (!confirm('Remove this session?\n（仍在執行的話會先終止）')) return;
  return run('remove', async () => {
    const id = props.id;
    await store.remove(id);
    await router.replace('/');
    pool.release(id);
  });
}

function openDesktop() {
  const takeover = confirm(
    '在桌面開啟 Terminal.app 後，是否同時終止 web session？\n\n' +
    '[ 確定 ] = 接管：桌面 Terminal 跑、kill 掉 web session、回到首頁\n' +
    '[ 取消 ] = 保留：兩邊都跑（背景同進程繼續、桌面也有一個）'
  );
  return run('open', async () => {
    const id = props.id;
    await api.openSessionDesktop(id);
    if (takeover) {
      try { await store.kill(id); } catch {}
      await router.replace('/');
    }
  });
}

// ───── 輸入 ─────
function claim() {
  pool.claim(props.id);
}

function onKey(seq) {
  claim();
  pool.sendKey(props.id, seq).catch((e) => console.warn('[keybar] send failed:', e.message));
}

async function sendComposer(text) {
  const id = props.id;
  pool.claim(id);
  if (text) {
    // 多行用 bracketed paste 包起來，TUI 才會當成一段貼上而不是每行都送出；
    // 換行比照 xterm 自己的貼上轉成 CR
    const body = text.includes('\n') ? `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~` : text;
    await pool.sendText(id, body);
    await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
  }
  await pool.sendText(id, '\r');
}

function onTermState(info) {
  termInfo.value = info;
}

// ───── session 不存在 ─────
const missing = ref(false);
let checkedFor = null;
watch(
  [() => props.id, () => store.loaded, () => !!session.value, () => !store.error],
  async ([id, loaded, found, ok]) => {
    if (found) { missing.value = false; return; }
    // 列表抓失敗（網路 / 401）時 items 不可信：等下一次成功再判斷
    if (!loaded || !ok) return;
    // 剛 spawn / restart 完列表可能還沒更新：強制重抓一次再下結論
    if (checkedFor !== id) {
      checkedFor = id;
      await store.refresh({ force: true });
    }
    if (props.id === id && !store.error && !store.byId(id)) {
      missing.value = true;
      pool.release(id);
    }
  },
  { immediate: true },
);

// stream 收到 exit 時馬上刷新列表，不用等下一輪 poll
watch(() => termState.value?.exited, (v) => { if (v) store.refresh({ force: true }); });

watch(() => props.id, () => {
  menuOpen.value = false;
  promptOpen.value = false;
  actionError.value = '';
});

onMounted(() => {
  if (!store.loaded) store.refresh();
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeydown);
});

onBeforeUnmount(() => {
  clearInterval(clock);
  clock = null;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown);
});
</script>

<template>
  <div class="sd">
    <div v-if="missing" class="missing">
      <p class="notice">找不到 session <code>{{ id.slice(0, 8) }}</code>（可能已移除，或 server 重新啟動過）。</p>
      <RouterLink to="/">← 回首頁</RouterLink>
    </div>

    <template v-else>
      <header class="head">
        <div
          class="ident"
          @mouseenter="identEnter"
          @mouseleave="identLeave"
          @click="identTap"
        >
          <div class="line1">
            <span class="lamp" :class="`st-${state}`" aria-hidden="true">{{ meta.icon }}</span>
            <h2 class="title">
              <button
                type="button"
                class="title-btn"
                :aria-expanded="promptOpen"
                :aria-describedby="lastPrompt ? 'sd-last-prompt-sr' : undefined"
                @focus="titleFocus"
                @blur="titleBlur"
                @click="titleActivate"
              >{{ title }}</button>
            </h2>
            <span class="chip" :class="`st-${state}`" :title="chipText">{{ chipText }}</span>
          </div>
          <span v-if="lastPrompt" id="sd-last-prompt-sr" class="sr-only">最近 prompt：{{ lastPrompt }}</span>
          <div class="line2">
            <span v-if="cwdLabel" class="cwd cwd-long">{{ cwdLabel }}</span>
            <span v-if="cwdTail" class="cwd cwd-tail"><span dir="ltr">{{ cwdTail }}</span></span>
            <span v-if="uptime" class="dot up">{{ uptime }}</span>
            <span v-if="ctxPct != null" class="dot" :class="{ low: ctxPct < 20 }">CTX {{ ctxPct }}%</span>
          </div>
          <div v-if="promptOpen && (lastPrompt || coarse)" class="popover" role="tooltip">
            <div class="pop-title">{{ title }}</div>
            <div class="pop-label">最近 PROMPT</div>
            <div class="pop-body">{{ lastPrompt || '（尚無紀錄）' }}</div>
            <div v-if="session?.cwd" class="pop-path">{{ session.cwd }}</div>
          </div>
        </div>

        <div class="actions">
          <button type="button" class="icon-btn" title="字小一點" :disabled="fontSize <= pool.FONT_MIN" @click="fontStep(-1)">A−</button>
          <span class="fs" :title="`字級 ${fontSize}px`">{{ fontSize }}</span>
          <button type="button" class="icon-btn" title="字大一點" :disabled="fontSize >= pool.FONT_MAX" @click="fontStep(1)">A+</button>
          <button
            type="button"
            class="icon-btn glyph only-desktop"
            :class="{ on: store.focusMode }"
            :title="store.focusMode ? '顯示側欄' : '專注模式（隱藏側欄）'"
            :aria-pressed="store.focusMode"
            @click="store.toggleFocusMode()"
          >⤢</button>
          <button
            type="button"
            class="icon-btn glyph"
            :class="{ on: composerOn }"
            title="輸入框 / 按鍵列"
            :aria-pressed="composerOn"
            @click="toggleComposer"
          >⌨</button>
          <div ref="menuRef" class="menu-wrap">
            <button
              type="button"
              class="icon-btn"
              title="更多動作"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >⋯</button>
            <div v-if="menuOpen" class="menu" role="menu">
              <button type="button" role="menuitem" :disabled="!!busyAction" title="在 macOS 桌面另開一個 Terminal.app 跑同樣命令" @click="openDesktop">↗ OPEN IN TERMINAL.APP</button>
              <button type="button" role="menuitem" :disabled="!!busyAction" @click="restart">↻ RESTART</button>
              <button type="button" role="menuitem" class="m-danger" :disabled="!!busyAction || exited" @click="kill">■ KILL</button>
              <button type="button" role="menuitem" class="m-danger" :disabled="!!busyAction || session?.removed" @click="remove">✕ REMOVE</button>
            </div>
          </div>
        </div>
      </header>

      <p v-if="actionError" class="error action-error">{{ actionError }}</p>

      <TerminalPane
        :session-id="id"
        :client-id="store.clientId"
        :exited="exited"
        @state="onTermState"
      />

      <div v-if="exited" class="exit-banner">
        <span class="exit-text">
          ✕ SESSION EXITED<template v-if="exitText"> · {{ exitText }}</template><template v-if="session?.removed"> · REMOVED</template>
        </span>
        <span class="spacer" />
        <button type="button" class="primary" :disabled="!!busyAction" @click="restart">↻ RESTART</button>
        <button v-if="!session?.removed" type="button" class="danger" :disabled="!!busyAction" @click="remove">REMOVE</button>
      </div>

      <div v-if="showKeyBar || showComposer" class="bottom">
        <KeyBar v-if="showKeyBar" @key="onKey" />
        <Composer v-if="showComposer" :session-id="id" :send="sendComposer" @interact="claim" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.sd {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}

/* ───── header ───── */
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--line-bright);
  background: var(--bg-soft);
  position: relative;
  z-index: 5;
}
.ident {
  position: relative;
  flex: 1;
  min-width: 0;
  cursor: default;
}
.line1 {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.title {
  margin: 0;
  /* chip 縮成 … 之前標題至少留幾個字，不會整個消失 */
  min-width: 8ch;
  flex: 0 1 auto;
  font-family: var(--display), var(--cjk);
  font-size: 19px;
  line-height: 1.3;
  letter-spacing: 0.02em;
  color: var(--amber);
  text-shadow: 0 0 10px var(--amber-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title-btn {
  all: unset;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.title-btn::before,
.title-btn::after { content: none; }
.title-btn:focus-visible { outline: 1px solid var(--amber-dim); outline-offset: 2px; }
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
.lamp {
  flex: none;
  font-size: 14px;
  line-height: 1;
}
.chip {
  /* 平板寬度放不下時 chip 自己縮成 …，不能擠到右邊的按鈕底下 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  letter-spacing: 0.1em;
  padding: 1px 8px;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.st-waiting { color: var(--amber); }
.lamp.st-waiting { animation: pulse 1.1s ease-in-out infinite; text-shadow: 0 0 8px var(--amber-glow); }
.chip.st-waiting { background: rgba(255, 184, 74, 0.12); }
.st-busy { color: var(--success); }
.st-idle { color: var(--cyan); }
.st-unknown { color: var(--bone); }
.st-ended { color: var(--dimmer); }
@keyframes pulse {
  50% { opacity: 0.35; }
}

.line2 {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  margin-top: 2px;
  font-size: 13px;
  color: var(--dim);
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cwd-tail { display: none; }
.dot { flex: none; }
.dot::before {
  content: '·';
  margin: 0 8px;
  color: var(--dimmer);
}
.line2 > .dot:first-child::before { display: none; }
.low { color: var(--danger); }

.popover {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  width: max-content;
  max-width: min(560px, calc(100vw - 32px));
  padding: 12px 14px;
  background: var(--bg-lift);
  border: 1px solid var(--amber-dim);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 18px var(--amber-glow);
  font-size: 14px;
  line-height: 1.55;
  white-space: normal;
}
.pop-title {
  color: var(--amber);
  font-family: var(--display), var(--cjk);
  margin-bottom: 8px;
  word-break: break-word;
}
.pop-label {
  font-size: 11.5px;
  letter-spacing: 0.18em;
  color: var(--dim);
}
.pop-body {
  color: var(--cream);
  font-family: var(--mono), var(--cjk);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow: auto;
}
.pop-path {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--dimmer);
  word-break: break-all;
}
/* 桌面是 hover 開的：滑鼠往下移到終端機時穿過 popover，點擊 / 選取要落在 xterm 上（同側欄的 popover） */
@media (hover: hover) and (pointer: fine) {
  .popover { pointer-events: none; }
  .pop-body { max-height: 30vh; }
}

/* ───── actions ───── */
.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon-btn {
  min-width: 38px;
  min-height: 36px;
  padding: 0 8px;
  font-size: 15px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--bone);
}
.icon-btn::before,
.icon-btn::after { content: none; }
.icon-btn.glyph { font-size: 19px; line-height: 1; }
.icon-btn.on {
  color: var(--amber);
  border-color: var(--amber-dim);
  box-shadow: inset 0 0 8px var(--amber-glow);
}
@media (pointer: coarse) {
  .icon-btn { min-width: 40px; min-height: 40px; }
}
.fs {
  min-width: 22px;
  text-align: center;
  font-size: 12px;
  color: var(--dimmer);
}
.menu-wrap { position: relative; }
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 30;
  min-width: 250px;
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 4px;
  background: var(--bg-lift);
  border: 1px solid var(--line-bright);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
}
.menu button {
  text-align: left;
  white-space: nowrap;
  font-size: 14px;
  min-height: 40px;
  border-color: transparent;
}
.menu button::before,
.menu button::after { content: none; }
.menu button:hover { border-color: var(--amber); }
.menu .m-danger { color: var(--danger); }
.menu .m-danger:hover { border-color: var(--danger); color: var(--danger); box-shadow: none; }

.action-error {
  flex: none;
  margin: 0;
  padding: 6px 16px;
  border-bottom: 1px solid var(--line);
}

/* ───── exited banner ───── */
.exit-banner {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--line-bright);
  background: var(--bg-soft);
}
.exit-text {
  color: var(--dim);
  font-size: 14px;
  letter-spacing: 0.12em;
}
.spacer { flex: 1; }

.bottom {
  flex: none;
  display: flex;
  flex-direction: column;
}

.missing {
  padding: 28px 36px;
}

@media (max-width: 767px) {
  /* 手機版的標題與狀態已經在 App 的 top bar：這裡只留路徑 / 時間 + 動作 */
  .line1 { display: none; }
  .head { padding: 4px 6px 4px 10px; gap: 6px; }
  .line2 { margin-top: 0; font-size: 12.5px; }
  .ident { cursor: pointer; }
  .only-desktop { display: none; }
  .icon-btn { min-width: 40px; min-height: 40px; padding: 0 6px; }
  .fs { display: none; }
  /* 窄螢幕讓位給路徑 */
  .up { display: none; }
  .cwd-long { display: none; }
  /* 空間不夠時從左邊截掉，保留最後一層資料夾（同側欄的 RTL 作法；內層 dir=ltr 保持字元順序） */
  .cwd-tail { display: inline; direction: rtl; text-align: left; }
  .missing { padding: 20px 16px; }
}
</style>
