<script setup>
// /artifact/:id — artifact 檢視頁（standalone：App.vue 不畫側欄，整頁給 artifact）。
// SPA 不拿原始 HTML：html kind 用 ArtifactFrame 載入 server 的 frame 路由（sandbox iframe），
// canvas kind 交給 CanvasBoard（C2）。這一頁負責：版本、模式（瀏覽 / 留言 / 便利貼）、
// 草稿自動儲存（800 ms debounce）、留言清單與編輯浮層、提交與提交紀錄、每 20 秒檢查有沒有新版本。
// 舊版本唯讀（提交 sheet 仍可打開來看當時寫的「給 Claude 的話」）；?v=N 指定版本（沒帶 = 最新）。
// 草稿的併發：每次 PUT / 提交都帶上次看到的 draft_updated_at（base_updated_at），別的分頁改過或已經提交 → 409，
// 這裡重新載入那一版的草稿（不會把已提交、已清掉的草稿寫回去）。
// 看著的版本被 Claude 發了新版：切到最新版時，新版本沒有草稿的話，把這一版的回覆帶過去（carryDraft）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { colorHex } from '../colors.js';
import ArtifactFrame from '../components/artifact/ArtifactFrame.vue';
import CanvasBoard from '../components/artifact/CanvasBoard.vue';
import CommentList from '../components/artifact/CommentList.vue';
import CommentEditor from '../components/artifact/CommentEditor.vue';
import SubmitSheet from '../components/artifact/SubmitSheet.vue';
import {
  LIMITS, carryDraft, createDraftSaver, emptyPayload, fmtDateTime, isBlank, isEmptyDraft, newCommentId, normalizeDraft,
  notifyLabel, payloadCounts, pinsFor, pruneForSubmit, relTimeFrom, targetLabel, utf8Bytes,
} from '../stores/artifact-draft.js';
import { useSessionsStore } from '../stores/sessions.js';

const props = defineProps({ id: { type: String, required: true } });
const route = useRoute();
const router = useRouter();
const sessions = useSessionsStore();

const POLL_MS = 20000;
const FLUSH_TIMEOUT_MS = 3000;
// keepalive 請求的 body 上限是 64 KiB（瀏覽器限制，算的是 UTF-8 位元組），留一點餘裕
const KEEPALIVE_MAX = 60000;

// ───── 狀態 ─────
const loading = ref(true);
const loadError = ref(null);         // { status, message, version }
const data = shallowRef(null);       // getArtifact 回應（不含 draft）：{ artifact, version, note, versions, view }
const draft = ref(emptyPayload());
const latestVersion = ref(null);     // 目前知道的最新版本（輪詢更新）
const isOldView = ref(false);        // 載入時就是舊版本 → 唯讀
const mode = ref('browse');          // 'browse' | 'comment' | 'sticky'
const panel = ref(null);             // null | 'comments' | 'history'
const submitOpen = ref(false);
const editing = ref(null);           // { id, anchor }
const focusId = ref(null);           // 目前聚焦的留言（釘選標記放大、清單亮起）
const hoverId = ref(null);
const saveStatus = ref('saved');     // 'saved' | 'pending' | 'saving' | 'error'
const saveError = ref('');
const notifyOn = ref(true);
const submitBusy = ref(false);
const submitResult = ref(null);
const submitError = ref(null);
const notice = ref('');
const history = ref({ items: [], loading: false, error: null });
const now = ref(Date.now());

const rootEl = ref(null);
const stageEl = ref(null);
const panelEl = ref(null);
const frameRef = ref(null);
const boardRef = ref(null);
const commentModeBtn = ref(null);
const listBtn = ref(null);
const histBtn = ref(null);
const submitBtn = ref(null);

// ───── 衍生 ─────
const artifact = computed(() => data.value?.artifact ?? null);
const view = computed(() => data.value?.view ?? null);
const kind = computed(() => artifact.value?.kind ?? view.value?.kind ?? 'html');
const isCanvas = computed(() => kind.value === 'canvas');
const version = computed(() => data.value?.version ?? null);
const readonly = computed(() => isOldView.value);
// 看的是載入當下的最新版，之後 Claude 又發了新版本：還能看、能改草稿，但不能提交（server 會 409）
const outdated = computed(() => (!readonly.value && latestVersion.value > version.value ? latestVersion.value : null));

const versionQuery = computed(() => {
  const v = Number.parseInt(String(route.query.v ?? ''), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
});

const versionOptions = computed(() => {
  const list = Array.isArray(data.value?.versions) ? [...data.value.versions] : [];
  if (!list.some((v) => v.version === version.value) && version.value != null) list.push({ version: version.value, note: data.value?.note });
  list.sort((a, b) => b.version - a.version);
  return list.map((v) => {
    const note = typeof v.note === 'string' ? v.note.replace(/\s+/g, ' ').trim() : '';
    const tag = v.version === latestVersion.value ? '（最新）' : '';
    return {
      version: v.version,
      label: `v${v.version}${tag}${note ? ` · ${note.length > 28 ? `${note.slice(0, 28)}…` : note}` : ''}`,
    };
  });
});
const latestNote = computed(() => {
  const v = (data.value?.versions ?? []).find((x) => x.version === latestVersion.value);
  const note = typeof v?.note === 'string' ? v.note.trim() : '';
  return note.length > 80 ? `${note.slice(0, 80)}…` : note;
});

// 來源 session（server 已經 resolveLive：terminal_id 是現在活著的那個）。host token 建的沒有來源 → null
const origin = computed(() => {
  const a = artifact.value;
  const o = a?.origin;
  if (o && (o.terminal_id || o.label)) return o;
  return a?.origin_label || a?.origin_terminal_id
    ? { terminal_id: a.origin_terminal_id ?? null, label: a.origin_label ?? null, alive: false, color: null }
    : null;
});
const originHex = computed(() => colorHex(origin.value?.color));
// resolveLive 之後的 id（restart 過會換 id）；server 沒給就用原本的
const originLiveId = computed(() => origin.value?.live_id || origin.value?.terminal_id || null);

const frames = computed(() => (isCanvas.value
  ? (view.value?.frames ?? []).map((f) => ({ id: f.id, title: f.title || f.id }))
  : [{ id: 'main', title: '頁面' }]));
const frameTitleOf = (fid) => frames.value.find((f) => f.id === fid)?.title || fid || '';

const counts = computed(() => payloadCounts(draft.value, view.value));
const commentTotal = computed(() => draft.value.comments.length);

const pins = computed(() => (isCanvas.value ? [] : pinsFor(draft.value.comments, 'main', editing.value?.id ?? focusId.value)));
const highlightRect = computed(() => {
  if (isCanvas.value || !hoverId.value) return null;
  const t = findComment(hoverId.value)?.target;
  const r = t?.rect;
  // selector 一起給：內層容器捲動的頁面，bridge 用它找到元素畫外框
  return r && Number.isFinite(r.x) && Number.isFinite(r.y) ? { ...r, selector: t.selector } : null;
});

const editingComment = computed(() => (editing.value ? findComment(editing.value.id) : null));
const editingIndex = computed(() => (editing.value ? draft.value.comments.findIndex((c) => c.id === editing.value.id) + 1 : null));

// 模式提示（html 與 canvas 都在這裡顯示；CanvasBoard 只在同一位置下方顯示上限之類的短暫訊息）
const modeHint = computed(() => {
  if (readonly.value) return '';
  const esc = isMobile.value ? '' : ' · Esc 回到瀏覽';
  if (mode.value === 'comment') {
    return isCanvas.value ? `留言模式：點 frame 裡想改的地方${esc}` : `留言模式：點頁面上想改的地方${esc}`;
  }
  if (mode.value === 'sticky' && isCanvas.value) return `便利貼模式：點畫布任一處貼一張${esc}`;
  return '';
});

const saveLabel = computed(() => {
  if (readonly.value) return '唯讀';
  switch (saveStatus.value) {
    case 'pending':
    case 'saving': return '儲存中…';
    case 'error': return '儲存失敗';
    default: return '已儲存';
  }
});

// ───── 手機判斷（編輯浮層 / 面板改成底部 sheet）─────
const mq = window.matchMedia('(max-width: 767px)');
const isMobile = ref(mq.matches);
function onMq() { isMobile.value = mq.matches; }

// ───── 草稿自動儲存 ─────
let saver = null;
// 這一份 saver 對應的草稿：stamp = server 的 draft_updated_at（併發檢查用；沒有草稿時是 null）。
// 每個 saver 有自己的 ctx：換版本 / artifact 之後，舊 saver 還在路上的回應只會改到舊的 ctx
let saverCtx = null;
let keepaliveNext = false;

function describeSaveError(err) {
  if (err?.status === 413) return '草稿太大，存不進去（留言或頁面資料太多）';
  if (err?.status === 404) return '這個 artifact 已經不存在';
  return err?.message || '網路錯誤';
}

function isDraftConflict(err) {
  return err?.status === 409 && err?.body?.code === 'draft_conflict';
}

function makeSaver(id, ver, stamp = null) {
  saver?.dispose();
  const ctx = { id, ver, stamp: typeof stamp === 'string' ? stamp : null, checkKept: false };
  saverCtx = ctx;
  saver = createDraftSaver({
    save: async (payload) => {
      const body = api.artifactDraftBody(ver, payload, ctx.stamp);
      // keepalive 的上限算的是 body 的 UTF-8 位元組（中文一個字 3 bytes），不是字元數；太大就送一般請求
      // （只是切到背景的話一般請求也送得完；真的關分頁時 64 KiB 以上本來就沒有辦法送）
      const keepalive = keepaliveNext && utf8Bytes(body) <= KEEPALIVE_MAX;
      const res = await api.saveArtifactDraft(id, ver, payload, { keepalive, body });
      if (typeof res?.updated_at === 'string') ctx.stamp = res.updated_at;
      if (ctx.checkKept) {
        ctx.checkKept = false;
        if (ctx === saverCtx) reportServerDropped(payload, res?.kept);
      }
      return res;
    },
    onStatus: (st, err) => {
      if (ctx !== saverCtx) return;
      saveStatus.value = st;
      saveError.value = st === 'error' ? describeSaveError(err) : '';
      if (st === 'error' && isDraftConflict(err)) reloadDraft({ reason: 'conflict' });
    },
  });
}

// 帶到新版本的回覆存進去之後，server 正規化時又丟掉的（例如作答的選項在新版本改了）：提示一下
function reportServerDropped(sent, kept) {
  if (!kept || typeof kept !== 'object') return;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const lost = [];
  const d = (k) => (Array.isArray(sent?.[k]) ? sent[k].length : 0) - n(kept[k]);
  if (d('comments') > 0) lost.push(`${d('comments')} 則留言`);
  if (Object.keys(sent?.answers ?? {}).length - n(kept.answers) > 0) lost.push(`${Object.keys(sent.answers).length - n(kept.answers)} 題作答`);
  if (d('selected') > 0) lost.push(`${d('selected')} 個「選這個」`);
  if (d('stickies') > 0) lost.push(`${d('stickies')} 張便利貼`);
  if (lost.length) flash(`新版本對不上的內容沒有帶過去：${lost.join('、')}。`);
}

// 重新載入這一版的草稿（別的分頁 / 裝置改過、或已經提交清掉了：server 回 409 draft_conflict）。
// 本機還沒存進去的修改會被 server 的內容取代
let reloadingDraft = null;
function reloadDraft({ reason = 'conflict' } = {}) {
  if (reloadingDraft) return reloadingDraft;
  const ctx = saverCtx;
  const seq = loadSeq;
  if (!ctx || !data.value) return Promise.resolve(false);
  reloadingDraft = (async () => {
    try {
      const res = await api.getArtifact(ctx.id, { version: ctx.ver });
      if (ctx !== saverCtx || seq !== loadSeq || !res?.artifact) return false;
      const d = normalizeDraft(res.draft);
      ctx.stamp = typeof res.draft_updated_at === 'string' ? res.draft_updated_at : null;
      editing.value = null;
      if (focusId.value && !d.comments.some((c) => c.id === focusId.value)) focusId.value = null;
      if (hoverId.value && !d.comments.some((c) => c.id === hoverId.value)) hoverId.value = null;
      latestVersion.value = Math.max(latestVersion.value ?? 0, res.artifact.current_version ?? 0);
      data.value = { ...data.value, artifact: res.artifact, versions: res.versions ?? data.value.versions };
      draft.value = d;
      saver?.reset(d);
      if (reason === 'conflict') flash('這份回覆在別的分頁或裝置改過（或已經提交）了，已載入最新的內容。');
      return true;
    } catch {
      return false;
    } finally {
      reloadingDraft = null;
    }
  })();
  return reloadingDraft;
}

function withTimeout(p, ms) {
  return Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

watch(draft, (d) => {
  // 提交進行中不存：server 收到提交會清掉這一版的草稿，這時候再 PUT 會把它寫回去（失敗時 doSubmit 會補排）
  if (!saver || readonly.value || !data.value || submitBusy.value) return;
  saver.schedule(d);
}, { deep: true });

function retrySave() {
  if (!saver || readonly.value) return;
  saver.schedule(draft.value);
  saver.flush();
}

// ───── 載入 ─────
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  const id = props.id;
  const v = versionQuery.value;
  // 切版本 / 換 artifact：先收掉編輯中的留言，讓 watcher 排進上一份草稿，再把它送出去
  if (editing.value) closeEditor();
  await nextTick();
  if (saver && !readonly.value) await withTimeout(saver.flush(), FLUSH_TIMEOUT_MS);
  if (seq !== loadSeq) return;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await api.getArtifact(id, { version: v });
    if (seq !== loadSeq) return;
    applyLoaded(res);
  } catch (e) {
    if (seq !== loadSeq) return;
    saver?.dispose();
    saver = null;
    data.value = null;
    loadError.value = { status: e.status ?? 0, message: e.message, version: v };
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function applyLoaded(res) {
  const { draft: rawDraft, draft_updated_at: stamp, ...rest } = res ?? {};
  if (!rest.artifact || !rest.view) throw Object.assign(new Error('server 回應格式不對'), { status: 500 });
  data.value = rest;
  latestVersion.value = rest.artifact.current_version ?? rest.version;
  isOldView.value = rest.version < latestVersion.value;
  mode.value = 'browse';
  editing.value = null;
  focusId.value = null;
  hoverId.value = null;
  submitResult.value = null;
  submitError.value = null;
  const d = normalizeDraft(rawDraft);
  makeSaver(rest.artifact.id ?? props.id, rest.version, stamp);
  saver.reset(d);
  draft.value = applyCarry(d, rest);
  if (panel.value === 'history') loadHistory();
}

// ───── 把舊版本的回覆帶到新版本 ─────
// 從「被新版本取代、但還沒提交」的那一版切到最新版時記下來；載入新版本後，新版本沒有草稿才帶（有就不動，舊的那一版
// 還留在 server，切回去看得到）。
let carry = null; // { id, from, to, payload }

function prepareCarry(target) {
  carry = null;
  if (!outdated.value || readonly.value || !data.value || target !== latestVersion.value) return;
  if (isEmptyDraft(draft.value)) return;
  carry = { id: artifact.value?.id ?? props.id, from: version.value, to: target, payload: JSON.parse(JSON.stringify(draft.value)) };
}

function applyCarry(d, res) {
  const c = carry;
  carry = null;
  if (!c || isOldView.value || res.version <= c.from || (res.artifact.id ?? props.id) !== c.id) return d;
  if (!isEmptyDraft(d)) {
    flash(`v${res.version} 已經有回覆的草稿，v${c.from} 寫的沒有帶過來（切回 v${c.from} 還看得到）。`);
    return d;
  }
  const r = carryDraft(c.payload, res.view, { kind: res.artifact.kind ?? res.view?.kind });
  if (isEmptyDraft(r.payload)) {
    flash(`v${c.from} 的回覆對不上新版本（frame / 題目都換了），沒有帶過來；切回 v${c.from} 還看得到。`);
    return d;
  }
  const skipped = [];
  if (r.dropped.comments) skipped.push(`${r.dropped.comments} 則留言`);
  if (r.dropped.answers) skipped.push(`${r.dropped.answers} 題作答`);
  if (r.dropped.selected) skipped.push(`${r.dropped.selected} 個「選這個」`);
  if (r.dropped.data) skipped.push('頁面送來的資料');
  flash(`已把 v${c.from} 還沒提交的回覆帶到 v${res.version}。${skipped.length ? `新版本對不上、沒帶過來的：${skipped.join('、')}。` : ''}留言的位置是舊版的，請確認一下。`);
  // 存進去（watch(draft) 也會排；這裡明確排一次）。server 存的時候又丟掉的（作答選項改了…）在回應的 kept 裡比對
  if (saverCtx) saverCtx.checkKept = true;
  nextTick(() => saver?.schedule(draft.value));
  return r.payload;
}

// 離開這一頁時 route 先變（?v 消失）才卸載元件：那一次不要重新載入
watch(() => [props.id, versionQuery.value], () => {
  if (route.name === 'artifact') load();
}, { immediate: true });

// ───── 輪詢：新版本 / 提交數 / session 是否還在 ─────
let pollTimer = null;
let polling = false;

async function poll() {
  if (polling || document.hidden || !data.value || loading.value) return;
  polling = true;
  const seq = loadSeq;
  const before = artifact.value;
  try {
    const res = await api.getArtifact(props.id, { version: data.value.version });
    if (seq !== loadSeq || !data.value || !res?.artifact) return;
    latestVersion.value = Math.max(latestVersion.value ?? 0, res.artifact.current_version ?? 0);
    data.value = { ...data.value, artifact: res.artifact, versions: res.versions ?? data.value.versions };
    if (panel.value === 'history' && (res.artifact.submission_count !== before?.submission_count
      || res.artifact.unread_count !== before?.unread_count)) loadHistory();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (e.status === 404) {
      saver?.dispose();
      saver = null;
      data.value = null;
      loadError.value = { status: 404, message: '這個 artifact 已經被刪除', version: null };
    }
  } finally {
    polling = false;
  }
}

function gotoVersion(v) {
  const n = Number(v);
  prepareCarry(Number.isFinite(n) && n > 0 ? n : latestVersion.value);
  const query = { ...route.query };
  if (!Number.isFinite(n) || n <= 0 || n === latestVersion.value) delete query.v;
  else query.v = String(n);
  if (String(query.v ?? '') === String(route.query.v ?? '')) {
    load(); // 網址沒變（例如本來就沒帶 ?v，最新版本變了）：直接重新載入
    return;
  }
  router.replace({ query });
}

function gotoLatest() {
  if (submitOpen.value) closeSubmit({ restoreFocus: false });
  gotoVersion(latestVersion.value);
}

// ───── 交給別的 session ─────
// MCP 只讓建立它的 session（含 restart 後接手的）改版；原本的 session 結束了，就從這裡交給另一個掛了 artifact 工具的 Claude session
const adoptOpen = ref(false);
const adoptBusy = ref(null);
const adoptError = ref('');
const adoptCandidates = computed(() => sessions.active.filter((x) => x.id !== originLiveId.value));
function toggleAdopt() {
  adoptOpen.value = !adoptOpen.value;
  adoptError.value = '';
  if (adoptOpen.value && !sessions.loaded) sessions.refresh?.();
}
async function adoptTo(s) {
  if (adoptBusy.value || !s?.id) return;
  adoptBusy.value = s.id;
  adoptError.value = '';
  try {
    const res = await api.setArtifactOrigin(props.id, s.id);
    if (res?.artifact && data.value) data.value = { ...data.value, artifact: res.artifact };
    adoptOpen.value = false;
    flash(`已交給「${res?.artifact?.origin?.label || s.title || s.profile_name || 'session'}」：之後由它改版、收提交通知。`);
  } catch (e) {
    adoptError.value = e.status === 409 ? '這個 session 不是掛了 artifact 工具的 Claude（或已經結束），沒辦法接手。' : `交接失敗：${e.message}`;
  } finally {
    adoptBusy.value = null;
  }
}

// ───── 模式 ─────
function setMode(m) {
  if (readonly.value && m !== 'browse') return;
  if (m === 'sticky' && !isCanvas.value) return;
  if (editing.value) closeEditor();
  mode.value = m;
}

function toggleMode(m) {
  setMode(mode.value === m ? 'browse' : m);
}

// ───── 留言 ─────
function findComment(id) {
  return draft.value.comments.find((c) => c.id === id) ?? null;
}

function removeComment(id) {
  draft.value.comments = draft.value.comments.filter((c) => c.id !== id);
  if (focusId.value === id) focusId.value = null;
  if (hoverId.value === id) hoverId.value = null;
  if (editing.value?.id === id) editing.value = null;
}

function updateText(id, text) {
  const c = findComment(id);
  if (c) c.text = text;
}

// anchor = { pageX, pageY }（viewport 座標，編輯框放在旁邊）+ 選用的 { frameId, clientX, clientY }（圓點在 frame 裡的位置）：
// 畫布平移縮放、frame 捲動之後用後者重新換算，編輯框才會跟著圓點走
function normAnchor(a) {
  if (!a || !Number.isFinite(a.pageX) || !Number.isFinite(a.pageY)) return null;
  const out = { pageX: a.pageX, pageY: a.pageY };
  if (Number.isFinite(a.clientX) && Number.isFinite(a.clientY)) {
    out.clientX = a.clientX;
    out.clientY = a.clientY;
    out.frameId = typeof a.frameId === 'string' ? a.frameId : null;
  }
  return out;
}

// frame 捲動 → 作用中的圓點換了位置（bridge 的 pin-pos）
function onPinMove(id, anchor) {
  const ed = editing.value;
  if (!ed || ed.id !== id) return;
  const a = normAnchor(anchor);
  if (a) editing.value = { ...ed, anchor: a };
}

// 畫布平移 / 縮放 → 用圓點在 frame 裡的位置重新換算 viewport 座標
function onViewportChange() {
  const ed = editing.value;
  const a = ed?.anchor;
  if (!ed || !isCanvas.value || !Number.isFinite(a?.clientX) || !a.frameId) return;
  const p = boardRef.value?.frameToPage?.(a.frameId, a.clientX, a.clientY);
  if (!p || (Math.abs(p.pageX - a.pageX) < 0.5 && Math.abs(p.pageY - a.pageY) < 0.5)) return;
  editing.value = { ...ed, anchor: { ...a, pageX: p.pageX, pageY: p.pageY } };
}

function openEditor(id, anchor) {
  if (editing.value && editing.value.id !== id) closeEditor();
  if (!findComment(id)) return;
  focusId.value = id;
  editing.value = { id, anchor: normAnchor(anchor) };
}

function closeEditor({ restoreFocus = false } = {}) {
  const ed = editing.value;
  if (!ed) return;
  editing.value = null;
  const c = findComment(ed.id);
  if (c && !readonly.value && isBlank(c.text)) removeComment(ed.id);
  if (restoreFocus) nextTick(() => commentModeBtn.value?.focus({ preventScroll: true }));
}

function onEditorClose(reason) {
  // 點外面關掉：焦點已經在使用者點的地方，不要搶
  closeEditor({ restoreFocus: reason !== 'outside' });
}

function focusComment(id) {
  const c = findComment(id);
  if (!c) return;
  focusId.value = id;
  if (isCanvas.value) boardRef.value?.focusComment?.(id);
  else if (Number.isFinite(c.x) && Number.isFinite(c.y)) frameRef.value?.scrollTo?.(c.x, c.y, c.target?.selector);
  // 手機的清單是蓋在畫面上的 sheet：收起來才看得到定位結果
  if (isMobile.value && panel.value) panel.value = null;
}

// html kind：ArtifactFrame 的事件
function onPick(ev) {
  if (readonly.value || mode.value !== 'comment' || !ev) return;
  closeEditor();
  // server 收到超過上限的草稿會整份拒收（之後每次自動儲存都失敗），跟畫布一樣先擋
  if (draft.value.comments.length >= LIMITS.comments) {
    flash(`留言最多 ${LIMITS.comments} 則（含空白的）。刪掉一些再留。`);
    return;
  }
  const c = {
    id: newCommentId(),
    frame_id: 'main',
    x: Number.isFinite(ev.x) ? Math.round(ev.x) : 0,
    y: Number.isFinite(ev.y) ? Math.round(ev.y) : 0,
    text: '',
    target: ev.target && typeof ev.target === 'object' ? ev.target : null,
  };
  draft.value.comments.push(c);
  openEditor(c.id, ev);
}

function onPinClick(ev) {
  if (ev?.id) openEditor(ev.id, ev);
}

function onPickCancel() {
  if (mode.value === 'comment') setMode('browse');
}

// window.codd.submit(data)：ArtifactFrame 可能給 { frameId, data } 或直接給 data
function unwrapData(ev) {
  if (ev && typeof ev === 'object' && !Array.isArray(ev) && 'data' in ev && ('frameId' in ev || 'type' in ev)) return ev.data;
  return ev;
}

function onSubmitData(ev) {
  if (readonly.value) {
    flash('這是舊版本，頁面送出的資料不能提交。切到最新版本再試一次。');
    return;
  }
  const d = unwrapData(ev);
  draft.value.data = d === undefined ? null : d;
  openSubmit();
}

// canvas kind：CanvasBoard 的事件（介面見規格 §9.2 / §9.3；另外接 update:mode、submit-data 與 highlightCommentId）
function onBoardDraft(d) {
  if (readonly.value || !d || typeof d !== 'object') return;
  draft.value = { ...emptyPayload(), ...d };
}

function onBoardMode(m) {
  if (m === 'browse' || m === 'comment' || m === 'sticky') setMode(m);
}

function onCommentCreated(comment, anchor) {
  if (readonly.value || !comment?.id) return;
  if (!findComment(comment.id)) {
    draft.value.comments.push({ ...comment, text: typeof comment.text === 'string' ? comment.text : '' });
  }
  openEditor(comment.id, anchor);
}

function onBoardPinClick(commentId, anchor) {
  if (commentId) openEditor(commentId, anchor);
}

// ───── 面板：留言清單 / 提交紀錄 ─────
function openPanel(p) {
  if (editing.value) closeEditor();
  panel.value = p;
  if (p === 'history' && !history.value.loading) loadHistory();
  nextTick(() => panelEl.value?.querySelector('.av-tab[aria-pressed="true"]')?.focus({ preventScroll: true }));
}

function togglePanel(p) {
  if (panel.value === p) closePanel(true);
  else openPanel(p);
}

function closePanel(restoreFocus = false) {
  const was = panel.value;
  panel.value = null;
  hoverId.value = null;
  if (restoreFocus) nextTick(() => (was === 'history' ? histBtn : listBtn).value?.focus({ preventScroll: true }));
}

async function loadHistory() {
  history.value = { ...history.value, loading: true, error: null };
  try {
    const res = await api.listArtifactSubmissions(props.id);
    const items = Array.isArray(res?.items) ? res.items : [];
    history.value = { items, loading: false, error: null };
  } catch (e) {
    history.value = { ...history.value, loading: false, error: e.message };
  }
}

const historyRows = computed(() => history.value.items.map((s) => ({
  s,
  parts: historyParts(s),
  detail: historyDetail(s),
})));

function historyCounts(item) {
  if (item?.payload && typeof item.payload === 'object') return payloadCounts(item.payload);
  const s = item?.summary_counts ?? {};
  const n = (v) => (Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0);
  return {
    comments: n(s.comments),
    answers: n(s.answers),
    selected: n(s.selected),
    stickies: n(s.stickies),
    hasMessage: !!(s.has_message ?? s.message),
    hasData: !!(s.has_data ?? s.data),
  };
}

function historyParts(item) {
  const c = historyCounts(item);
  const parts = [];
  if (c.comments) parts.push(`${c.comments} 留言`);
  if (c.answers) parts.push(`${c.answers} 作答`);
  if (c.selected) parts.push(`選 ${c.selected}`);
  if (c.stickies) parts.push(`${c.stickies} 便利貼`);
  if (c.hasMessage) parts.push('有留話');
  if (c.hasData) parts.push('頁面資料');
  return parts.length ? parts.join(' · ') : '（空的）';
}

function questionPrompt(qid) {
  return view.value?.questions?.find((q) => q.id === qid)?.prompt || qid;
}

function answerText(v) {
  return Array.isArray(v) ? v.join('、') : String(v ?? '');
}

function historyDetail(item) {
  const p = item?.payload;
  if (!p || typeof p !== 'object') return null;
  const d = normalizeDraft(p);
  return {
    message: d.message.trim(),
    comments: d.comments.filter((c) => !isBlank(c.text)).map((c, i) => ({
      key: c.id || i,
      where: frameTitleOf(c.frame_id),
      target: targetLabel(c.target),
      text: c.text,
    })),
    answers: Object.entries(d.answers).map(([k, v]) => ({ key: k, prompt: questionPrompt(k), answer: answerText(v) })),
    selected: d.selected.map(frameTitleOf),
    stickies: d.stickies.filter((s) => !isBlank(s.text)).map((s, i) => ({ key: s.id || i, text: s.text })),
    hasData: d.data != null,
  };
}

// ───── 提交 ─────
// 舊版本也打得開（唯讀）：看當時寫的「給 Claude 的話」與摘要，可以選取複製；不能提交
function openSubmit() {
  if (editing.value) closeEditor();
  submitResult.value = null;
  submitError.value = null;
  submitOpen.value = true;
}

function closeSubmit({ restoreFocus = true } = {}) {
  submitOpen.value = false;
  submitResult.value = null;
  submitError.value = null;
  if (restoreFocus) nextTick(() => submitBtn.value?.focus({ preventScroll: true }));
}

async function doSubmit() {
  if (submitBusy.value || !data.value || readonly.value) return;
  submitBusy.value = true;
  submitError.value = null;
  submitResult.value = null;
  const ver = data.value.version;
  const payload = pruneForSubmit(draft.value, { kind: kind.value });
  const alive = !!origin.value?.alive;
  const ctx = saverCtx;
  // 排隊中的草稿不送了、進行中的等它回來：不然提交後 server 清掉的草稿會被寫回去
  await saver?.settle();
  try {
    // session 不在時照樣送 notify:true，讓 server 判斷（restart 過的 session 可能又活著）→ no_session。
    // base：上次存好的草稿版本；別的分頁改過或已經提交 → 409 draft_conflict，不會重複提交舊內容
    const res = await api.submitArtifact(props.id, {
      version: ver, payload, notify: alive ? notifyOn.value : true, base: ctx ? ctx.stamp : undefined,
    });
    submitResult.value = res ?? { notify: { status: 'none' } };
    if (ctx) ctx.stamp = null; // server 提交時清掉了這一版的草稿
    const fresh = emptyPayload();
    draft.value = fresh;
    saver?.reset(fresh);
    editing.value = null;
    focusId.value = null;
    hoverId.value = null;
    mode.value = 'browse';
    const a = artifact.value;
    if (a) {
      data.value = {
        ...data.value,
        artifact: {
          ...a,
          submission_count: (a.submission_count ?? 0) + 1,
          unread_count: (a.unread_count ?? 0) + 1,
          last_submission_at: res?.submission?.created_at ?? a.last_submission_at,
        },
      };
    }
    // 桌面的提交紀錄面板可能一直開在旁邊
    if (panel.value === 'history') loadHistory();
  } catch (e) {
    if (isDraftConflict(e)) {
      // 別的分頁 / 裝置改過或已經提交：載入 server 上的版本，請使用者確認後再送
      await reloadDraft({ reason: 'submit' });
      submitError.value = {
        status: 409,
        code: 'draft_conflict',
        message: '這份回覆在別的分頁或裝置改過（或已經提交）了，已載入最新的內容。確認一下再提交。',
      };
      return;
    }
    submitError.value = {
      status: e.status ?? 0,
      message: e.status === 409
        ? 'Claude 已經發布新版本，這一版不能再提交。切到最新版本時，還沒提交的回覆會一起帶過去（新版本對不上的除外）。'
        : e.status === 413
          ? `內容太大，server 拒收：${e.message}`
          : `提交失敗：${e.message}`,
    };
    if (e.status === 409) poll();
    // 沒送出去：草稿照常存回去
    saver?.schedule(draft.value);
  } finally {
    submitBusy.value = false;
  }
}

function showHistoryFromSheet() {
  closeSubmit({ restoreFocus: false });
  openPanel('history');
}

// ───── 一次性提示 ─────
let noticeTimer = null;
function flash(text) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 5000);
}

// ───── 鍵盤：Esc 一次只退一層（編輯浮層 → 提交 sheet → 手機面板 → 模式）─────
// 在 setup 裡就掛上（capture）：比子元件（CanvasBoard）在 onMounted 掛的 listener 先執行，處理掉就 stopImmediatePropagation
function onKeydownCapture(e) {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  const ae = document.activeElement;
  // 元件自己要處理的 Esc（例如留言清單的行內刪除確認）
  if (ae?.closest?.('[data-esc-local]')) return;
  let handled = true;
  if (adoptOpen.value) adoptOpen.value = false;
  else if (editing.value) closeEditor({ restoreFocus: true });
  else if (submitOpen.value) {
    if (!submitBusy.value) closeSubmit();
  } else if (panel.value && (isMobile.value || panelEl.value?.contains(ae))) closePanel(true);
  else if (stageEl.value?.contains(ae) && ae.matches?.('input, textarea, select, [contenteditable="true"]')) handled = false; // 交給 CanvasBoard（例如便利貼編輯中）
  else if (mode.value !== 'browse') setMode('browse');
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
window.addEventListener('keydown', onKeydownCapture, true);

// 「交給…」的選單：點外面就收起來
function onDocPointerdown(e) {
  if (adoptOpen.value && !(e.target instanceof Element && e.target.closest('.av-adopt'))) adoptOpen.value = false;
}
document.addEventListener('pointerdown', onDocPointerdown, true);

// ───── 生命週期 ─────
let clock = null;

function onVisibility() {
  if (document.hidden) {
    // 切到背景 / 關分頁：排隊中的草稿立刻送（小的用 keepalive，頁面卸載後也送得出去）
    if (saver?.dirty && !readonly.value) {
      keepaliveNext = true;
      saver.flush().finally(() => { keepaliveNext = false; });
    }
  } else {
    poll();
  }
}

onMounted(() => {
  pollTimer = setInterval(poll, POLL_MS);
  clock = setInterval(() => { now.value = Date.now(); }, 30000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onVisibility);
  mq.addEventListener?.('change', onMq);
});

onBeforeRouteLeave(async () => {
  if (editing.value) closeEditor();
  await nextTick();
  if (saver && !readonly.value) await withTimeout(saver.flush(), FLUSH_TIMEOUT_MS);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydownCapture, true);
  document.removeEventListener('pointerdown', onDocPointerdown, true);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onVisibility);
  mq.removeEventListener?.('change', onMq);
  clearInterval(pollTimer);
  clearInterval(clock);
  clearTimeout(noticeTimer);
  loadSeq++;
  const s = saver;
  saver = null;
  if (s) s.flush().finally(() => s.dispose());
});
</script>

<template>
  <div ref="rootEl" class="av" :class="{ mobile: isMobile }">
    <!-- ───── 載入中 / 錯誤 ───── -->
    <div v-if="!data" class="av-state">
      <p v-if="loading" class="notice">// loading artifact …</p>
      <template v-else-if="loadError">
        <p v-if="loadError.status === 404 && loadError.version" class="error">找不到這個 artifact 的 v{{ loadError.version }}。</p>
        <p v-else-if="loadError.status === 404" class="error">找不到這個 artifact（可能已經刪除，或網址打錯）。</p>
        <p v-else class="error">讀取失敗：{{ loadError.message }}</p>
        <div class="av-state-actions">
          <button v-if="loadError.status === 404 && loadError.version" type="button" @click="gotoVersion(null)">看最新版本</button>
          <button v-else-if="loadError.status !== 404" type="button" @click="load">重試</button>
          <RouterLink to="/artifacts">← ARTIFACTS</RouterLink>
        </div>
      </template>
    </div>

    <template v-else>
      <!-- ───── 頂列 ───── -->
      <header class="av-top">
        <div class="av-id">
          <RouterLink to="/artifacts" class="av-back" aria-label="回 ARTIFACTS 列表" title="回 ARTIFACTS 列表">
            <span aria-hidden="true">←</span><span class="av-back-text">ARTIFACTS</span>
          </RouterLink>
          <h1 class="av-title" :title="artifact.title">{{ artifact.title }}</h1>
          <span class="av-kind" :class="kind">{{ isCanvas ? 'CANVAS' : 'HTML' }}</span>
          <label class="sr-only" for="av-ver">版本</label>
          <select
            id="av-ver"
            class="av-ver"
            :value="version"
            :title="data.note ? `v${version}：${data.note}` : `v${version}`"
            @change="gotoVersion($event.target.value)"
          >
            <option v-for="o in versionOptions" :key="o.version" :value="o.version">{{ o.label }}</option>
          </select>
          <RouterLink
            v-if="origin?.alive && originLiveId"
            :to="`/sessions/${originLiveId}`"
            class="av-origin"
            :style="originHex ? { '--oc': originHex } : null"
            :title="`建立它的 session：${origin.label || originLiveId}`"
          ><span class="av-odot" aria-hidden="true" />{{ origin.label || 'session' }}</RouterLink>
          <span v-else-if="origin?.label" class="av-origin ended" :title="`建立它的 session（已結束）：${origin.label}`">
            <span class="av-odot" aria-hidden="true" />{{ origin.label }}
          </span>
          <div v-if="!readonly && !origin?.alive" class="av-adopt">
            <button
              type="button"
              class="av-adopt-btn"
              :aria-expanded="adoptOpen"
              aria-haspopup="true"
              :aria-label="origin ? '原本的 session 已經結束：找另一個 Claude session 接手' : '找一個 Claude session 接手（之後由它改版、收提交通知）'"
              :title="origin ? '原本的 session 已經結束：找另一個 Claude session 接手' : '找一個 Claude session 接手（之後由它改版、收提交通知）'"
              @click="toggleAdopt"
            >接手…</button>
            <div v-if="adoptOpen" class="av-adopt-pop" role="group" aria-label="選一個 session 接手">
              <p class="av-adopt-help">只有掛了 artifact 工具的 Claude session 可以接手。接手之後由它用 artifact_update 改版、收到提交通知。</p>
              <p v-if="!adoptCandidates.length" class="av-adopt-help">現在沒有其他執行中的 session。</p>
              <ul v-else class="av-adopt-list">
                <li v-for="s in adoptCandidates" :key="s.id">
                  <button type="button" :disabled="!!adoptBusy" @click="adoptTo(s)">
                    <span class="av-odot" :style="colorHex(s.color) ? { '--oc': colorHex(s.color) } : null" aria-hidden="true" />
                    {{ s.title || s.profile_name || s.id.slice(0, 8) }}<template v-if="adoptBusy === s.id"> …</template>
                  </button>
                </li>
              </ul>
              <p v-if="adoptError" class="av-adopt-err" role="alert">{{ adoptError }}</p>
            </div>
          </div>
          <button
            v-if="saveStatus === 'error' && !readonly"
            type="button"
            class="av-save error"
            :title="`${saveError}（點一下重試）`"
            @click="retrySave"
          >儲存失敗 ↻</button>
          <span v-else class="av-save" :class="readonly ? 'ro' : saveStatus" role="status" aria-live="polite">{{ saveLabel }}</span>
        </div>

        <div class="av-tools" role="toolbar" aria-label="檢視工具">
          <div class="av-modes" role="group" aria-label="模式">
            <button type="button" class="av-mode" :aria-pressed="mode === 'browse'" @click="setMode('browse')">瀏覽</button>
            <button
              ref="commentModeBtn"
              type="button"
              class="av-mode"
              :aria-pressed="mode === 'comment'"
              :disabled="readonly"
              :title="readonly ? '舊版本不能留言' : '點頁面上的元素留言'"
              @click="toggleMode('comment')"
            >留言</button>
            <button
              v-if="isCanvas"
              type="button"
              class="av-mode"
              :aria-pressed="mode === 'sticky'"
              :disabled="readonly"
              :title="readonly ? '舊版本不能貼便利貼' : '在畫布上貼便利貼'"
              @click="toggleMode('sticky')"
            >便利貼</button>
          </div>
          <span class="av-spacer" />
          <button
            ref="listBtn"
            type="button"
            class="av-tool"
            :aria-pressed="panel === 'comments'"
            :aria-label="`留言清單（${commentTotal} 則）`"
            @click="togglePanel('comments')"
          >清單<span class="av-count">{{ commentTotal }}</span></button>
          <button
            ref="histBtn"
            type="button"
            class="av-tool"
            :aria-pressed="panel === 'history'"
            :aria-label="`提交紀錄（${artifact.submission_count ?? 0} 次）`"
            @click="togglePanel('history')"
          >紀錄<span class="av-count">{{ artifact.submission_count ?? 0 }}</span></button>
          <button
            ref="submitBtn"
            type="button"
            class="av-submit"
            :class="{ primary: !readonly }"
            :title="readonly ? '舊版本不能提交：打開來看當時寫的內容' : '把回覆提交給 Claude'"
            @click="openSubmit"
          >{{ readonly ? '查看' : '提交' }}<span v-if="counts.items" class="av-count">{{ counts.items }}</span></button>
        </div>
      </header>

      <!-- ───── 橫幅 ───── -->
      <div v-if="readonly" class="av-banner old" role="status">
        <span>這是舊版本 v{{ version }}（唯讀）。</span>
        <button type="button" class="av-bbtn" @click="gotoLatest">切到最新 v{{ latestVersion }}</button>
      </div>
      <div v-else-if="outdated" class="av-banner new" role="status">
        <span>Claude 發布了新版本 v{{ outdated }}<template v-if="latestNote">：{{ latestNote }}</template>。這一版的回覆不能再提交。</span>
        <button type="button" class="av-bbtn" @click="gotoLatest">切過去</button>
      </div>
      <div v-if="notice" class="av-banner notice" role="status">
        <span>{{ notice }}</span>
        <button type="button" class="av-bbtn" aria-label="關閉提示" @click="notice = ''">✕</button>
      </div>

      <!-- ───── 主體 ───── -->
      <div class="av-body">
        <div ref="stageEl" class="av-stage" :class="kind">
          <ArtifactFrame
            v-if="!isCanvas && view.frame"
            :key="view.frame.src"
            ref="frameRef"
            class="av-html"
            :src="view.frame.src"
            frame-id="main"
            :pick-mode="mode === 'comment' && !readonly"
            :pins="pins"
            :highlight-rect="highlightRect"
            :title="artifact.title"
            @pick="onPick"
            @pin-click="onPinClick"
            @submit-data="onSubmitData"
            @pick-cancel="onPickCancel"
            @pin-move="onPinMove($event.id, $event)"
          />
          <CanvasBoard
            v-else-if="isCanvas"
            :key="`${artifact.id}-v${version}`"
            ref="boardRef"
            class="av-canvas"
            :view="view"
            :draft="draft"
            :mode="mode"
            :readonly="readonly"
            :focus-comment-id="editing?.id ?? focusId"
            :highlight-comment-id="hoverId"
            @update:draft="onBoardDraft"
            @update:mode="onBoardMode"
            @comment-created="onCommentCreated"
            @pin-click="onBoardPinClick"
            @submit-data="onSubmitData"
            @pin-move="onPinMove"
            @viewport-change="onViewportChange"
          />
          <p v-else class="av-empty">這個版本沒有內容。</p>
          <p v-if="modeHint" class="av-mode-hint" aria-live="polite">{{ modeHint }}</p>
        </div>

        <div v-if="panel && isMobile" class="av-panel-backdrop" @click="closePanel(true)" />
        <aside
          v-if="panel"
          ref="panelEl"
          class="av-panel"
          :class="{ sheet: isMobile }"
          :aria-label="panel === 'comments' ? '留言清單' : '提交紀錄'"
        >
          <header class="av-ptabs">
            <div class="av-tablist" role="group" aria-label="面板內容">
              <button
                type="button"
                class="av-tab"
                :aria-pressed="panel === 'comments'"
                @click="openPanel('comments')"
              >留言 {{ commentTotal }}</button>
              <button
                type="button"
                class="av-tab"
                :aria-pressed="panel === 'history'"
                @click="openPanel('history')"
              >提交紀錄 {{ artifact.submission_count ?? 0 }}</button>
            </div>
            <button type="button" class="av-x" aria-label="關閉面板" title="關閉" @click="closePanel(true)">✕</button>
          </header>

          <div class="av-pbody">
            <CommentList
              v-if="panel === 'comments'"
              :comments="draft.comments"
              :frames="frames"
              :active-id="editing?.id ?? focusId"
              :readonly="readonly"
              :hint="readonly ? '這個版本沒有留言。' : '還沒有留言。按上面的「留言」，再點頁面上想改的地方。'"
              @focus="focusComment"
              @hover="hoverId = $event"
              @update-text="updateText"
              @delete="removeComment"
            />

            <div v-else class="av-hist">
              <p v-if="history.loading && !history.items.length" class="av-pnote">// loading …</p>
              <p v-else-if="history.error" class="av-perr">讀取失敗：{{ history.error }}
                <button type="button" class="av-bbtn" @click="loadHistory">重試</button>
              </p>
              <p v-else-if="!history.items.length" class="av-pnote">還沒有提交過。</p>
              <ul v-else class="av-hlist">
                <li v-for="{ s, parts, detail: d } in historyRows" :key="s.id ?? s.seq" class="av-hitem">
                  <div class="av-hline">
                    <span class="av-hseq">#{{ s.seq }}</span>
                    <span class="av-hver">v{{ s.version }}</span>
                    <span class="av-htime" :title="fmtDateTime(s.created_at)">{{ relTimeFrom(s.created_at, now) }}</span>
                    <span class="av-hread" :class="{ unread: !s.read_at }" :title="s.read_at ? `Claude 讀取於 ${fmtDateTime(s.read_at)}` : 'Claude 還沒用 artifact_read_submissions 讀過'">
                      {{ s.read_at ? 'Claude 已讀' : 'Claude 未讀' }}
                    </span>
                  </div>
                  <div class="av-hmeta">
                    <span>{{ parts }}</span>
                    <span class="av-hnotify" :class="`n-${s.notify_status}`">通知：{{ notifyLabel(s.notify_status) }}</span>
                  </div>
                  <details v-if="d" class="av-hdetail">
                    <summary>內容</summary>
                    <p v-if="d.message" class="av-hmsg">{{ d.message }}</p>
                      <p v-if="d.selected.length" class="av-hrow"><span class="k">選這個</span>{{ d.selected.join('、') }}</p>
                      <ul v-if="d.answers.length" class="av-hsub">
                        <li v-for="a in d.answers" :key="a.key"><span class="k">{{ a.prompt }}</span> → {{ a.answer }}</li>
                      </ul>
                      <ul v-if="d.comments.length" class="av-hsub">
                        <li v-for="c in d.comments" :key="c.key">
                          <span class="k"><template v-if="isCanvas">[{{ c.where }}] </template>{{ c.target || '留言' }}</span>{{ c.text }}
                        </li>
                      </ul>
                      <ul v-if="d.stickies.length" class="av-hsub">
                        <li v-for="st in d.stickies" :key="st.key"><span class="k">便利貼</span> {{ st.text }}</li>
                      </ul>
                    <p v-if="d.hasData" class="av-hrow"><span class="k">頁面資料</span>有（window.codd.submit）</p>
                  </details>
                </li>
              </ul>
            </div>
          </div>
        </aside>
      </div>

      <CommentEditor
        v-if="editingComment"
        :key="editingComment.id"
        :comment="editingComment"
        :n="editingIndex"
        :frame-title="frameTitleOf(editingComment.frame_id)"
        :anchor="editing.anchor"
        :sheet="isMobile"
        :readonly="readonly"
        @update:text="updateText(editingComment.id, $event)"
        @delete="removeComment(editingComment.id)"
        @close="onEditorClose"
      />

      <SubmitSheet
        v-if="submitOpen"
        :payload="draft"
        :view="view"
        :kind="kind"
        :origin="origin"
        :notify="notifyOn"
        :readonly="readonly"
        :outdated="outdated"
        :busy="submitBusy"
        :result="submitResult"
        :error="submitError"
        :sheet="isMobile"
        @update:message="draft.message = $event"
        @update:notify="notifyOn = $event"
        @clear-data="draft.data = null"
        @submit="doSubmit"
        @close="closeSubmit()"
        @goto-latest="gotoLatest"
        @show-history="showHistoryFromSheet"
      />
    </template>
  </div>
</template>

<style scoped>
.av {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}

/* ───── 載入 / 錯誤 ───── */
.av-state {
  padding: 28px 36px;
}
.av-state-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 12px;
}

/* ───── 頂列 ───── */
.av-top {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 6px 10px 6px 12px;
  padding-top: calc(6px + env(safe-area-inset-top));
  border-bottom: 1px solid var(--line-bright);
  background: var(--bg-soft);
  position: relative;
  z-index: 20;
}
/* 寬度不夠放「標題列 + 工具列」時（約 < 900px）自動換成兩列 */
.av-id {
  flex: 1 1 480px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.av-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 4px;
  border-bottom: none;
  color: var(--dim);
  font-size: 12px;
  letter-spacing: 0.14em;
}
.av-back:hover { color: var(--amber); }
.av-title {
  flex: 0 1 auto;
  min-width: 6ch;
  margin: 0;
  font-family: var(--display), var(--cjk);
  font-size: 17px;
  line-height: 1.3;
  letter-spacing: 0.02em;
  color: var(--amber);
  text-shadow: 0 0 10px var(--amber-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.av-kind {
  flex: none;
  padding: 0 6px;
  border: 1px solid currentColor;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  color: var(--cyan);
}
.av-kind.canvas { color: var(--amber-dim); }
.av-ver {
  flex: 0 1 auto;
  min-width: 76px;
  max-width: 220px;
  padding: 2px 26px 2px 8px;
  font-size: 13px;
  text-overflow: ellipsis;
}
.av-origin {
  --oc: var(--dimmer);
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 0;
  border-bottom: none;
  font-size: 12.5px;
  color: var(--bone);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.av-origin.ended { color: var(--dimmer); }
a.av-origin:hover { color: var(--amber); }
.av-odot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--oc);
}
.av-origin.ended .av-odot { background: transparent; border: 1px dashed var(--dimmer); }
.av-adopt {
  position: relative;
  flex: none;
}
.av-adopt-btn {
  min-height: 26px;
  padding: 1px 8px;
  border: 1px dashed var(--line-bright);
  background: transparent;
  color: var(--dim);
  font-family: var(--cjk);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: none;
  white-space: nowrap;
}
.av-adopt-btn::before,
.av-adopt-btn::after { content: none; }
.av-adopt-btn:hover,
.av-adopt-btn[aria-expanded='true'] { color: var(--amber); border-color: var(--amber-dim); box-shadow: none; }
.av-adopt-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 70;
  width: min(320px, calc(100vw - 24px));
  padding: 10px;
  border: 1px solid var(--amber-dim);
  background: var(--bg-soft);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.75);
  font-family: var(--cjk);
  font-size: 12.5px;
}
.av-adopt-help { margin: 0 0 8px; color: var(--dim); line-height: 1.5; }
.av-adopt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.av-adopt-list button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 8px;
  border: 1px solid var(--line-bright);
  background: var(--bg);
  color: var(--bone);
  font-family: var(--cjk);
  font-size: 13px;
  text-align: left;
  text-transform: none;
  letter-spacing: 0;
}
.av-adopt-list button::before,
.av-adopt-list button::after { content: none; }
.av-adopt-list button:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); box-shadow: none; }
.av-adopt-list .av-odot { --oc: var(--dimmer); }
.av-adopt-err { margin: 8px 0 0; color: var(--danger); line-height: 1.5; }
.av-save {
  flex: none;
  margin-left: auto;
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--dimmer);
  white-space: nowrap;
}
.av-save.saving,
.av-save.pending { color: var(--amber-dim); }
button.av-save.error {
  border: none;
  padding: 0 4px;
  min-height: 28px;
  text-transform: none;
  color: var(--danger);
}
button.av-save.error::before,
button.av-save.error::after { content: none; }
button.av-save.error:hover { box-shadow: none; text-decoration: underline; }

.av-tools {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.av-spacer { display: none; }
.av-modes {
  display: flex;
  border: 1px solid var(--line-bright);
}
/* 工具列按鈕：不要全域 button 的 [ ] 與大寫 */
.av-mode,
.av-tool {
  min-height: 32px;
  padding: 2px 10px;
  border: none;
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: none;
  color: var(--bone);
  white-space: nowrap;
}
.av-mode::before,
.av-mode::after,
.av-tool::before,
.av-tool::after { content: none; }
.av-mode + .av-mode { border-left: 1px solid var(--line-bright); }
.av-mode:hover,
.av-tool:hover { color: var(--amber); box-shadow: none; }
.av-mode[aria-pressed='true'] {
  background: var(--amber);
  color: #000;
}
.av-tool { border: 1px solid var(--line-bright); }
.av-tool[aria-pressed='true'] {
  color: var(--amber);
  border-color: var(--amber-dim);
  box-shadow: inset 0 0 8px var(--amber-glow);
}
.av-count {
  margin-left: 6px;
  font-size: 11.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.av-tool[aria-pressed='true'] .av-count { color: var(--amber-dim); }
.av-submit {
  min-height: 32px;
  padding: 2px 12px;
  font-size: 13px;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
.av-submit.primary .av-count { color: #000; font-weight: 700; }

/* ───── 橫幅 ───── */
.av-banner {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.45;
}
.av-banner > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.av-banner.old { background: rgba(255, 184, 74, 0.08); color: var(--amber); }
.av-banner.new { background: rgba(110, 224, 240, 0.08); color: var(--cyan); }
.av-banner.notice { background: var(--bg-lift); color: var(--cream); }
.av-bbtn {
  flex: none;
  padding: 1px 10px;
  font-size: 12.5px;
  letter-spacing: 0.06em;
  text-transform: none;
}

/* ───── 主體 ───── */
.av-body {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.av-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
/* html kind：iframe 填滿；artifact 多半預設白底 */
.av-stage.html :deep(.av-html) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.av-stage.html :deep(iframe) {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
/* canvas kind：CanvasBoard 填滿舞台（它自己處理平移縮放） */
.av-stage :deep(.av-canvas) {
  position: absolute;
  inset: 0;
}
.av-empty {
  padding: 24px;
  color: var(--dimmer);
}
.av-mode-hint {
  position: absolute;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  z-index: 15;
  max-width: calc(100% - 24px);
  margin: 0;
  padding: 4px 12px;
  background: rgba(5, 5, 5, 0.86);
  border: 1px solid var(--amber-dim);
  color: var(--amber);
  font-size: 12.5px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

/* ───── 面板（桌面：右側停靠；手機：底部 sheet）───── */
.av-panel {
  flex: none;
  width: 340px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line-bright);
  background: var(--bg-soft);
  z-index: 25;
}
.av-panel.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  max-height: 72%;
  border-left: none;
  border-top: 1px solid var(--amber-dim);
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.8);
  padding-bottom: env(safe-area-inset-bottom);
  animation: av-up 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.av-panel-backdrop {
  position: absolute;
  inset: 0;
  z-index: 24;
  background: rgba(0, 0, 0, 0.5);
}
.av-ptabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 0 8px;
  border-bottom: 1px dashed var(--line-bright);
}
.av-tablist {
  flex: 1;
  display: flex;
  gap: 2px;
  min-width: 0;
}
.av-tab {
  min-height: 34px;
  padding: 2px 10px;
  border: none;
  border-bottom: 2px solid transparent;
  font-size: 12.5px;
  letter-spacing: 0.08em;
  text-transform: none;
  color: var(--dim);
  white-space: nowrap;
}
.av-tab::before,
.av-tab::after { content: none; }
.av-tab:hover { color: var(--cream); box-shadow: none; }
.av-tab[aria-pressed='true'] {
  color: var(--amber);
  border-bottom-color: var(--amber);
}
.av-x {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  font-size: 14px;
  letter-spacing: 0;
  color: var(--dim);
}
.av-x::before,
.av-x::after { content: none; }
.av-x:hover { color: var(--amber); box-shadow: none; }
.av-pbody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 10px 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-bright) transparent;
}
.av-pnote {
  margin: 4px 0;
  font-size: 12.5px;
  color: var(--dimmer);
}
.av-perr {
  margin: 4px 0;
  font-size: 12.5px;
  color: var(--danger);
}

/* 提交紀錄 */
.av-hlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.av-hitem {
  padding: 6px 8px 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: 12.5px;
  line-height: 1.45;
}
.av-hline {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.av-hseq { color: var(--amber); font-weight: 600; }
.av-hver { color: var(--dim); }
.av-htime { color: var(--dim); }
.av-hread {
  margin-left: auto;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--success);
  white-space: nowrap;
}
.av-hread.unread { color: var(--amber-dim); }
.av-hmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin-top: 2px;
  color: var(--bone);
}
.av-hnotify { color: var(--dim); }
.av-hnotify.n-sent { color: var(--cyan); }
.av-hnotify.n-pending { color: var(--amber-dim); }
.av-hnotify.n-failed { color: var(--danger); }
.av-hdetail {
  margin-top: 4px;
  color: var(--bone);
}
.av-hdetail summary {
  cursor: pointer;
  color: var(--dim);
  font-size: 11.5px;
}
.av-hmsg {
  margin: 4px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--cream);
}
.av-hrow { margin: 4px 0; overflow-wrap: anywhere; }
.av-hsub {
  margin: 4px 0;
  padding-left: 16px;
  overflow-wrap: anywhere;
}
.av-hsub li { white-space: pre-wrap; }
.av-hdetail .k { color: var(--dim); margin-right: 6px; }

.av :is(a, button, select, summary):focus-visible {
  outline: 1px solid var(--amber);
  outline-offset: 2px;
}

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

@keyframes av-up {
  from { transform: translateY(100%); }
  to { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .av-panel.sheet { animation: none; }
}

/* 觸控：可點的東西至少 40px */
@media (pointer: coarse) {
  .av-mode,
  .av-tool,
  .av-submit,
  .av-tab,
  .av-back { min-height: 40px; }
  .av-x { width: 40px; height: 40px; }
  .av-bbtn { min-height: 36px; }
  .av-ver { min-height: 36px; font-size: 16px; }
}

/* ───── 手機（< 768px）───── */
@media (max-width: 767px) {
  .av-state { padding: 20px 16px; }
  .av-top {
    gap: 4px 8px;
    padding: 4px 8px 6px 4px;
    padding-top: calc(4px + env(safe-area-inset-top));
  }
  .av-id {
    flex: 1 1 100%;
    gap: 8px;
  }
  .av-back { padding: 0 8px; font-size: 18px; }
  .av-back-text { display: none; }
  .av-title { font-size: 15px; flex: 1 1 auto; }
  .av-kind { font-size: 9.5px; letter-spacing: 0.1em; }
  .av-ver { max-width: 96px; padding-left: 6px; }
  .av-origin { display: none; }
  .av-save { margin-left: 0; font-size: 11px; }
  .av-tools { flex: 1 1 100%; gap: 4px; }
  .av-spacer { display: block; flex: 1; }
  .av-mode { padding: 2px 9px; }
  .av-tool { padding: 2px 8px; }
  .av-count { margin-left: 4px; }
  .av-submit { padding: 2px 10px; letter-spacing: 0.04em; }
  .av-submit::before,
  .av-submit::after { content: none; }
  .av-banner { padding: 6px 10px; font-size: 12.5px; }
  .av-mode-hint { top: 6px; font-size: 12px; white-space: normal; text-align: center; }
}
@media (min-width: 768px) {
  .av-back-text { margin-left: 2px; }
}
</style>
