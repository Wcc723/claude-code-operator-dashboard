<script>
import { ref as moduleRef } from 'vue';

// 所有 SetupGuide 共用同一份狀態：/setup 或首頁裝好之後，側欄的精簡提示馬上跟著消失
const sharedStatus = moduleRef(null);
</script>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';

const props = defineProps({ compact: Boolean });
const emit = defineEmits(['status']);

const DISMISS_KEY = 'codd.setup.dismissed';

const status = sharedStatus;
const loading = ref(!status.value);
const loadError = ref(null);
const selected = ref([]);
const plan = ref(null);
const planBusy = ref(false);
const busy = ref(null); // 'install' | 'uninstall' | null
const actionError = ref(null);
const result = ref(null);
const now = ref(Date.now());
const copied = ref(false);
const dismissed = ref(readDismissed());

function readDismissed() {
  try { return Boolean(localStorage.getItem(DISMISS_KEY)); } catch { return false; }
}
function dismiss() {
  dismissed.value = true;
  try { localStorage.setItem(DISMISS_KEY, new Date().toISOString()); } catch {}
}

const STATE = {
  installed: { text: '已安裝', tone: 'ok', glyph: '●' },
  outdated: { text: '需要更新', tone: 'warn', glyph: '◆' },
  missing: { text: '未安裝', tone: 'off', glyph: '○' },
};

function needsAction(s, part) {
  if (!s) return false;
  if (part === 'legacy') return Boolean(s.legacy?.present);
  return s[part]?.state !== 'installed';
}

const parts = computed(() => {
  const s = status.value;
  if (!s) return [];
  return ['hooks', 'statusline', ...(s.legacy?.present ? ['legacy'] : [])];
});
const pending = computed(() => parts.value.filter((p) => needsAction(status.value, p)));
const installedParts = computed(() =>
  ['hooks', 'statusline'].filter((p) => status.value?.[p]?.state && status.value[p].state !== 'missing'));
const complete = computed(() => Boolean(status.value?.complete));
const settingsPath = computed(() => status.value?.settings_path || '~/.claude/settings.json');

async function load({ resetSelection = false } = {}) {
  loading.value = !status.value;
  loadError.value = null;
  try {
    const s = await api.getSetup();
    const first = !status.value;
    status.value = s;
    now.value = Date.now();
    setSelected(resetSelection || first ? pending.value : selected.value.filter((p) => parts.value.includes(p)));
    emit('status', s);
  } catch (e) {
    loadError.value = e.message;
  } finally {
    loading.value = false;
  }
}

// 內容沒變就不換 array，免得重新檢查時把預覽清掉
function setSelected(list) {
  const cur = selected.value;
  if (list.length === cur.length && list.every((p, i) => p === cur[i])) return;
  selected.value = list.slice();
}

// 勾選改了，舊的預覽就不準了
watch(selected, () => { plan.value = null; });

async function preview() {
  if (!selected.value.length) return;
  planBusy.value = true;
  actionError.value = null;
  try {
    const p = await api.planSetup(selected.value);
    plan.value = (p?.changes || []).map((c) => ({ ...c, diff: lineDiff(toText(c.before), toText(c.after)) }));
  } catch (e) {
    actionError.value = `預覽失敗：${e.message}`;
  } finally {
    planBusy.value = false;
  }
}

async function install() {
  if (!selected.value.length || busy.value) return;
  busy.value = 'install';
  actionError.value = null;
  result.value = null;
  try {
    const r = await api.applySetup(selected.value);
    result.value = { kind: 'install', parts: uniq(r?.applied || []), backups: r?.backups || [] };
    plan.value = null;
    await load({ resetSelection: true });
  } catch (e) {
    actionError.value = `安裝失敗：${e.message}`;
  } finally {
    busy.value = null;
  }
}

async function uninstall() {
  const target = installedParts.value;
  if (!target.length || busy.value) return;
  const names = target.map((p) => (p === 'hooks' ? 'hooks' : 'statusLine')).join(' 與 ');
  if (!confirm(`要從 ${settingsPath.value} 移除 CODD 的 ${names} 嗎？\n如果原本就有 statusLine，會還原成原本的指令。`)) return;
  busy.value = 'uninstall';
  actionError.value = null;
  result.value = null;
  try {
    const r = await api.uninstallSetup(target);
    result.value = { kind: 'uninstall', parts: uniq(r?.applied || target), backups: r?.backups || [] };
    plan.value = null;
    await load({ resetSelection: true });
  } catch (e) {
    actionError.value = `移除失敗：${e.message}`;
  } finally {
    busy.value = null;
  }
}

function uniq(list) { return [...new Set(list)]; }

async function copyCli() {
  try {
    await navigator.clipboard.writeText('npm run setup -- install');
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {}
}

// 回到分頁時重新檢查：裝完之後開新 session 就能看到資料進來；在 server 上用 CLI 裝好的，精簡提示也會消失
function onVisible() {
  if (document.hidden) return;
  now.value = Date.now();
  if (!busy.value) load();
}
let ticker = null;
onMounted(() => {
  load({ resetSelection: true });
  ticker = setInterval(() => {
    now.value = Date.now();
    // 精簡提示還掛著時順便重新檢查（另一台裝置 / CLI 裝好後不用等重新掛載）
    if (props.compact && !document.hidden && status.value && !complete.value && !dismissed.value) load();
  }, 30000);
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisible);
});

function ago(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, (now.value - t) / 1000);
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const items = computed(() => {
  const s = status.value;
  if (!s) return [];
  const data = s.data || {};
  const list = [];

  const hooks = s.hooks || {};
  const hookDetail = [];
  if (hooks.state === 'outdated' && hooks.events_missing?.length) {
    hookDetail.push(`缺少事件：${hooks.events_missing.join(', ')}`);
  }
  if (hooks.state === 'outdated' && hooks.events_outdated?.length) {
    hookDetail.push(`指令需要更新：${hooks.events_outdated.join(', ')}`);
  }
  list.push({
    part: 'hooks',
    name: 'Hooks',
    purpose: '讓側欄知道每個 session 正在忙、等你回覆或閒置，並記下最近一次 prompt。',
    state: STATE[hooks.state] || STATE.missing,
    detail: hookDetail,
    fresh: [{ label: '最近收到資料', at: data.hook_last_at }],
    emptyHint: hooks.state === 'installed' ? '從 CODD 開一個新的 session 後就會有資料。' : null,
  });

  const sl = s.statusline || {};
  const slDetail = [];
  if (sl.mode === 'wrapped') slDetail.push('已串接你原本的 statusLine 指令，終端機上的顯示不變。');
  else if (sl.mode === 'standalone') slDetail.push('CODD 自己輸出一行精簡狀態。');
  else if (sl.has_foreign) slDetail.push('安裝時會保留並串接你原本的 statusLine 指令，顯示維持原樣。');
  else slDetail.push('目前沒有 statusLine，安裝後會顯示一行：資料夾 · 模型 · context · 5h 剩餘。');
  list.push({
    part: 'statusline',
    name: 'Statusline',
    purpose: '取得 Claude Code 的 session 標題、context 剩餘與目前帳號的 5h/1w 用量。',
    state: STATE[sl.state] || STATE.missing,
    detail: slDetail,
    fresh: [
      { label: '最近收到資料', at: data.statusline_last_at },
      { label: '用量資料', at: data.usage_last_at },
    ],
    emptyHint: sl.state === 'installed' ? 'Claude Code 下一次更新 statusLine 時就會有資料。' : null,
  });

  if (s.legacy?.present) {
    list.push({
      part: 'legacy',
      name: 'Legacy hook',
      purpose: '移除舊的 channel 級 PostToolUse hook，避免和新的 hooks 重複觸發。',
      state: { text: '偵測到舊設定', tone: 'warn', glyph: '◆' },
      detail: [s.legacy.file ? `位置：${s.legacy.file}` : '位置在 channel 目錄的 .claude/settings.json。'],
      fresh: [],
      emptyHint: null,
    });
  }
  return list;
});

function toggle(part) {
  const set = new Set(selected.value);
  if (set.has(part)) set.delete(part);
  else set.add(part);
  setSelected(parts.value.filter((p) => set.has(p)));
}

const showBanner = computed(() =>
  props.compact && !loading.value && !loadError.value && status.value && !complete.value && !dismissed.value);

// ── 預覽用的行 diff（LCS），變更區塊很小，直接算 ──
function toText(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
function lineDiff(a, b) {
  const A = a ? a.split('\n') : [];
  const B = b ? b.split('\n') : [];
  const n = A.length;
  const m = B.length;
  if (n * m > 400000) {
    return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] });
    else out.push({ t: '+', s: B[j++] });
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}
const DIFF_CLASS = { ' ': 'ctx', '-': 'del', '+': 'add' };
const PART_LABEL = { hooks: 'HOOKS', statusline: 'STATUSLINE', legacy: 'LEGACY' };
</script>

<template>
  <!-- 精簡模式：一行提示，完成或關掉後就不再出現 -->
  <div v-if="showBanner" class="banner" role="status">
    <span class="b-glyph" aria-hidden="true">◆</span>
    <span class="b-msg">完成設定以取得 session 狀態與 5h/1w 用量</span>
    <RouterLink to="/setup" class="b-go">→ 設定</RouterLink>
    <button type="button" class="b-dismiss" aria-label="不再顯示這個提示" title="不再顯示" @click="dismiss">✕</button>
  </div>

  <section v-else-if="!compact" class="setup-guide">
    <header class="sg-head">
      <div class="sg-title">
        <span class="sg-label">CLAUDE CODE 設定</span>
        <span v-if="status" class="overall" :class="complete ? 'ok' : 'warn'">
          {{ complete ? '● 設定完成' : `◆ ${pending.length} 項待處理` }}
        </span>
      </div>
      <button type="button" class="small" :disabled="loading || !!busy" @click="load()">↻ 重新檢查</button>
    </header>

    <p v-if="loading" class="notice">// 讀取設定狀態…</p>
    <p v-else-if="loadError" class="error">無法讀取設定狀態：{{ loadError }}</p>

    <template v-if="status">
      <p v-if="status.error" class="error">讀取 {{ settingsPath }} 失敗：{{ status.error }}</p>
      <ul v-if="status.warnings?.length" class="warnings">
        <li v-for="w in status.warnings" :key="w">{{ w }}</li>
      </ul>

      <div class="explain">
        <p>
          <strong>會改什麼：</strong>只修改這台 server 主機上的
          <code>{{ settingsPath }}</code> 裡的 <code>hooks</code> 與 <code>statusLine</code> 兩個區塊。
          你原本的 hooks 會保留，CODD 只附加自己的項目；如果原本就有 statusLine，會被包起來照常執行。
        </p>
        <p>
          <strong>為什麼：</strong>CODD 開的 session 都帶著 <code>CODD_TERMINAL_ID</code>。
          hooks 在 Claude Code 事件發生時寫一個小的狀態檔，statusLine 順便記下標題、context 與用量，
          側欄和底部的用量面板就是讀這些檔案<template v-if="status.status_dir">（放在 <code>{{ status.status_dir }}</code>）</template>。不是 CODD 開的 session，hook 指令檢查這個變數後就直接結束，幾乎沒有負擔；
          statusLine 則會替每個 session 記下 5h/1w 用量百分比，不存 email 或 token。
        </p>
        <p>
          <strong>可以還原：</strong>寫入前會先備份成 <code>settings.json.codd-bak-&lt;時間&gt;</code>，
          之後按下方「移除」或執行 <code>npm run setup -- uninstall</code> 就會拿掉。
          新開的 session 會直接套用，已在執行的 session 可能要 RESTART 後才會回報狀態。
        </p>
      </div>

      <ul class="checklist">
        <li v-for="it in items" :key="it.part" class="item" :class="[it.state.tone, { picked: selected.includes(it.part) }]">
          <label class="pick">
            <input
              type="checkbox"
              :checked="selected.includes(it.part)"
              :disabled="!!busy"
              @change="toggle(it.part)"
            />
            <span class="it-name">{{ it.name }}</span>
            <span class="it-state"><span aria-hidden="true">{{ it.state.glyph }}</span> {{ it.state.text }}</span>
          </label>
          <p class="it-purpose">{{ it.purpose }}</p>
          <p v-for="(d, i) in it.detail" :key="i" class="it-detail">{{ d }}</p>
          <p v-for="f in it.fresh" :key="f.label" class="it-fresh" :class="{ none: !ago(f.at) }">
            {{ f.label }}：{{ ago(f.at) || '尚未收到資料' }}
          </p>
          <p v-if="it.emptyHint && it.fresh.length && !ago(it.fresh[0].at)" class="it-hint">{{ it.emptyHint }}</p>
        </li>
      </ul>

      <div class="actions">
        <button type="button" :disabled="!selected.length || planBusy || !!busy" @click="preview">
          {{ planBusy ? '預覽中…' : '預覽變更' }}
        </button>
        <button type="button" class="primary" :disabled="!selected.length || !!busy" @click="install">
          {{ busy === 'install' ? '安裝中…' : complete && !selected.length ? '已是最新' : '安裝選取項目' }}
        </button>
        <span class="spacer" />
        <button v-if="installedParts.length" type="button" class="danger" :disabled="!!busy" @click="uninstall">
          {{ busy === 'uninstall' ? '移除中…' : '移除' }}
        </button>
      </div>
      <p v-if="!selected.length && !complete" class="notice">// 勾選要處理的項目</p>

      <p v-if="actionError" class="error">{{ actionError }}</p>
      <div v-if="result" class="result">
        <p v-if="!result.parts.length">沒有需要變更的項目。</p>
        <p v-else>
          {{ result.kind === 'install' ? '已套用' : '已移除' }}：{{ result.parts.join(', ') }}。
          <template v-if="result.kind === 'install'">新開的 session 會直接生效。</template>
        </p>
        <p v-for="b in result.backups" :key="b" class="backup">備份：<code>{{ b }}</code></p>
      </div>

      <div v-if="plan" class="plan">
        <p v-if="!plan.length" class="notice">// 選取的項目都已是最新，沒有需要變更的地方。</p>
        <div v-for="(c, idx) in plan" :key="idx" class="change">
          <div class="c-head">
            <span class="c-part">{{ PART_LABEL[c.part] || c.part }}</span>
            <code class="c-file">{{ c.file }}</code>
          </div>
          <p v-if="c.summary" class="c-summary">{{ c.summary }}</p>
          <pre class="diff" :aria-label="`${c.part} 變更預覽`"><code class="d-body"><span v-for="(l, i) in c.diff" :key="i" :class="DIFF_CLASS[l.t]">{{ l.t }} {{ l.s }}</span></code></pre>
        </div>
        <p v-if="plan.length" class="legend"><span class="del">- 移除</span> <span class="add">+ 新增</span> 只列出會動到的區塊，其他設定不變。</p>
      </div>

      <div class="cli">
        <div class="cli-head">
          <span class="sg-label">CLI</span>
          <button type="button" class="small" @click="copyCli">{{ copied ? '已複製' : '複製指令' }}</button>
        </div>
        <p>
          也可以在執行 CODD server 的那台機器（例如 Mac mini）上，於 repo 根目錄用指令完成。
          從手機或筆電按上面的按鈕，一樣是寫入 server 那台機器的設定。
        </p>
        <pre class="cmd"><span class="c-dim"># 查看狀態 / 預覽 / 安裝 / 移除</span>
npm run setup -- status
npm run setup -- install --dry-run
npm run setup -- install
npm run setup -- uninstall
<span class="c-dim"># 只處理部分項目</span>
npm run setup -- install --only hooks,statusline</pre>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* ── compact banner ── */
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 8px 8px 14px;
  border: 1px solid var(--amber-dim);
  background: linear-gradient(90deg, var(--amber-glow) 0%, transparent 70%), var(--bg-soft);
  font-size: 14px;
  line-height: 1.45;
}
.b-glyph { color: var(--amber); text-shadow: 0 0 6px var(--amber-glow); }
.b-msg { color: var(--cream); flex: 1 1 14em; min-width: 0; }
.b-go { white-space: nowrap; }
.b-dismiss {
  min-width: 36px;
  min-height: 36px;
  padding: 0 8px;
  border-color: transparent;
  color: var(--dim);
  letter-spacing: 0;
}
.b-dismiss::before,
.b-dismiss::after { content: none; }
.b-dismiss:hover { border-color: var(--line-bright); box-shadow: none; }

/* ── full ── */
.setup-guide {
  max-width: 860px;
  font-size: 15px;
  line-height: 1.65;
  color: var(--bone);
}
.sg-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.sg-title {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  flex: 1;
}
.sg-label {
  font-family: var(--display);
  font-size: 14px;
  letter-spacing: 0.18em;
  color: var(--amber);
}
.overall { font-size: 14px; letter-spacing: 0.04em; }
.overall.ok { color: var(--success); }
.overall.warn { color: var(--amber); }
button.small { font-size: 13px; padding: 4px 10px; }

.warnings {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  color: var(--amber);
  font-size: 14px;
}
.warnings li::before { content: '◆ '; }

.explain {
  border-left: 2px solid var(--amber-dim);
  padding: 2px 0 2px 14px;
  margin-bottom: 18px;
}
.explain p { margin: 0 0 8px; }
.explain p:last-child { margin-bottom: 0; }
.explain strong { color: var(--cream); font-weight: 600; }
code {
  font-family: var(--mono);
  font-size: 0.9em;
  color: var(--amber);
  background: var(--bg);
  border: 1px solid var(--line);
  padding: 0 5px;
  /* 只有整段放不下一行時才在字中間斷 */
  word-break: normal;
  overflow-wrap: anywhere;
}

.checklist {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: grid;
  gap: 8px;
}
.item {
  border: 1px solid var(--line-bright);
  background: var(--bg-soft);
  padding: 10px 14px 12px;
}
.item.picked { border-color: var(--amber-dim); }
.pick {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  min-height: 32px;
}
.pick input { width: 18px; height: 18px; margin: 0; flex: none; }
.it-name {
  font-family: var(--display);
  font-size: 15px;
  letter-spacing: 0.1em;
  color: var(--cream);
}
.it-state {
  margin-left: auto;
  font-size: 13.5px;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.item.ok .it-state { color: var(--success); }
.item.warn .it-state { color: var(--amber); }
.item.off .it-state { color: var(--dimmer); }
.it-purpose { margin: 6px 0 2px; color: var(--bone); }
.it-detail,
.it-fresh,
.it-hint {
  margin: 2px 0 0;
  font-size: 13.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.it-fresh::before { content: '› '; color: var(--dimmer); }
.it-fresh.none { color: var(--dimmer); }
.it-hint { color: var(--dimmer); }

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.actions .spacer { flex: 1; }
.actions button { min-height: 40px; }

.result {
  margin-top: 12px;
  padding: 10px 14px;
  border: 1px solid var(--success);
  color: var(--cream);
  font-size: 14px;
}
.result p { margin: 0; }
.result .backup { color: var(--dim); margin-top: 4px; }

.plan { margin-top: 16px; }
.change { margin-bottom: 14px; }
.c-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.c-part {
  font-size: 12.5px;
  letter-spacing: 0.16em;
  color: var(--amber);
}
.c-file { font-size: 12.5px; }
.c-summary { margin: 0 0 6px; font-size: 14px; color: var(--bone); }
pre.diff,
pre.cmd {
  margin: 0;
  padding: 10px 12px;
  background: #000;
  border: 1px solid var(--line-bright);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  overflow: auto;
  white-space: pre;
}
pre.diff { max-height: 420px; }
/* inline-block + min-width 讓每行底色延伸到水平捲動的全寬 */
pre.diff .d-body {
  display: inline-block;
  min-width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-size: inherit;
  word-break: normal;
}
pre.diff span { display: block; }
.ctx { color: var(--dimmer); }
.del { color: var(--danger); }
.add { color: var(--success); }
pre.diff .del { background: rgba(255, 112, 88, 0.08); }
pre.diff .add { background: rgba(124, 255, 154, 0.07); }
.legend { margin: 6px 0 0; font-size: 13px; color: var(--dim); }

.cli {
  margin-top: 22px;
  padding-top: 14px;
  border-top: 1px dashed var(--line-bright);
}
.cli-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.cli p { margin: 0 0 8px; font-size: 14px; color: var(--dim); }
pre.cmd { color: var(--cream); }
.c-dim { color: var(--dimmer); }

@media (pointer: coarse) {
  .b-go {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
  }
  .b-dismiss { min-width: 40px; min-height: 40px; }
  .pick { min-height: 40px; }
}

@media (max-width: 767px) {
  .setup-guide { font-size: 14.5px; }
  .item { padding: 10px 12px; }
  .actions button { flex: 1 1 auto; }
  .actions .spacer { display: none; }
}
</style>
