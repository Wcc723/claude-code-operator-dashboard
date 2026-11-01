// Artifact 回覆草稿的純函式與自動儲存控制器（ArtifactView / SubmitSheet / CommentList / ArtifactsList 共用）。
// 不是 Pinia store：草稿只屬於一個檢視頁，狀態放在 ArtifactView 自己身上；這裡不 import Vue，node 直接 import 就能測。
// payload 形狀見 ARTIFACT 規格 §4：{ message, comments, answers, selected, stickies, data }。
import { relTime } from '../lib/usage-format.js';

// 和 server 的 normalizePayload 對齊的上限（client 端只用來提示，真正的驗證在 server）
export const LIMITS = {
  message: 8000,
  commentText: 4000,
  stickyText: 2000,
  answerText: 4000,
  // 數量：超過的草稿 / 提交 server 會整個拒收（400），之後每次自動儲存都會失敗，所以 client 端直接擋（空白留言也算）
  comments: 200,
  stickies: 100,
};

export function emptyPayload() {
  return { message: '', comments: [], answers: {}, selected: [], stickies: [], data: null };
}

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * server 給的 draft → 完整的 payload。
 * 吃三種形狀：null（沒有草稿）、payload 本身、{ payload, updated_at } 包一層；缺的欄位補預設值。
 */
export function normalizeDraft(raw) {
  let p = raw;
  if (isObj(p) && isObj(p.payload) && !('comments' in p) && !('message' in p)) p = p.payload;
  if (!isObj(p)) return emptyPayload();
  return {
    message: typeof p.message === 'string' ? p.message : '',
    comments: Array.isArray(p.comments) ? p.comments.filter(isObj).map((c) => ({ ...c, text: typeof c.text === 'string' ? c.text : '' })) : [],
    answers: isObj(p.answers) ? { ...p.answers } : {},
    selected: Array.isArray(p.selected) ? p.selected.filter((x) => typeof x === 'string') : [],
    stickies: Array.isArray(p.stickies) ? p.stickies.filter(isObj).map((s) => ({ ...s, text: typeof s.text === 'string' ? s.text : '' })) : [],
    data: p.data === undefined ? null : p.data,
  };
}

export function isBlank(text) {
  return typeof text !== 'string' || text.trim() === '';
}

function randomToken(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** 新留言 id：c_ + 8 碼 [a-z0-9]（符合 server 的 ^[A-Za-z0-9_-]{1,40}$） */
export function newCommentId() {
  return `c_${randomToken(8)}`;
}

function answered(v) {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 提交前整理：丟掉空白留言、空白便利貼、沒作答的題目；html kind 沒有 selected / stickies。
 * 不改動傳進來的物件（草稿保留空留言，server 規格也是「提交時才丟」）。
 */
export function pruneForSubmit(payload, { kind } = {}) {
  const p = normalizeDraft(payload);
  const answers = {};
  for (const [k, v] of Object.entries(p.answers)) {
    if (answered(v)) answers[k] = Array.isArray(v) ? [...v] : v;
  }
  return {
    message: p.message.trim() === '' ? '' : p.message,
    comments: p.comments.filter((c) => !isBlank(c.text)).map((c) => ({ ...c })),
    answers,
    selected: kind === 'html' ? [] : [...p.selected],
    stickies: kind === 'html' ? [] : p.stickies.filter((s) => !isBlank(s.text)).map((s) => ({ ...s })),
    data: p.data ?? null,
  };
}

/**
 * 提交摘要的數字（SubmitSheet、提交按鈕、提交紀錄共用）。
 * view = getArtifact 的 view（canvas 才有 questions / frames）；可省略。
 */
export function payloadCounts(payload, view = null) {
  const p = normalizeDraft(payload);
  const questions = Array.isArray(view?.questions) ? view.questions : null;
  const questionIds = questions ? new Set(questions.map((q) => q.id)) : null;
  const comments = p.comments.filter((c) => !isBlank(c.text)).length;
  const answeredIds = Object.entries(p.answers)
    .filter(([k, v]) => answered(v) && (!questionIds || questionIds.has(k)))
    .map(([k]) => k);
  const stickies = p.stickies.filter((s) => !isBlank(s.text)).length;
  const hasMessage = p.message.trim() !== '';
  const hasData = p.data != null;
  return {
    comments,
    emptyComments: p.comments.length - comments,
    answers: answeredIds.length,
    questions: questions ? questions.length : null,
    selected: p.selected.length,
    selectedIds: [...p.selected],
    stickies,
    hasMessage,
    hasData,
    // 提交按鈕上的數字：使用者「標了幾樣東西」（給 Claude 的話與 data 不算）
    items: comments + answeredIds.length + p.selected.length + stickies,
    empty: !hasMessage && !hasData && comments + answeredIds.length + p.selected.length + stickies === 0,
  };
}

/** 被點到的元素 → 一行摘要：<button#go.cta.big>「開始使用」 */
export function targetLabel(target, { maxText = 40 } = {}) {
  if (!isObj(target) || typeof target.tag !== 'string' || !target.tag) return '';
  const id = typeof target.id === 'string' && target.id ? `#${target.id}` : '';
  const classes = Array.isArray(target.classes)
    ? target.classes.filter((c) => typeof c === 'string' && c).slice(0, 2).map((c) => `.${c}`).join('')
    : '';
  let text = typeof target.text === 'string' ? target.text.replace(/\s+/g, ' ').trim() : '';
  if (text.length > maxText) text = `${text.slice(0, maxText)}…`;
  return `<${target.tag.toLowerCase()}${id}${classes}>${text ? `「${text}」` : ''}`;
}

function isoMs(iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** ISO 時間 → 「剛剛 / N 分鐘前 / N 小時前 / N 天前」；超過 30 天寫日期 */
export function relTimeFrom(iso, nowMs) {
  const t = isoMs(iso);
  if (t == null) return '';
  const sec = Math.max(0, (nowMs - t) / 1000);
  if (sec >= 30 * 86400) return fmtDateTime(iso, { time: false });
  return relTime(sec);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ISO 時間 → 本地時間 2026-11-01 15:04（time:false 只寫日期） */
export function fmtDateTime(iso, { time = true } = {}) {
  const t = isoMs(iso);
  if (t == null) return '';
  const d = new Date(t);
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return time ? `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : day;
}

// 提交的通知狀態（server：none|pending|sent|no_session|expired|failed|disabled|skipped）
// skipped：輪到送的時候 Claude 已經讀過這次提交（或 artifact 已刪除），不用再打通知
export const NOTIFY_LABEL = {
  none: '—',
  pending: '等 session 閒置',
  sent: '已通知',
  no_session: 'session 已結束',
  expired: '等太久，沒有通知',
  failed: '通知失敗',
  disabled: '沒有通知',
  skipped: 'Claude 已讀，不必通知',
};

export function notifyLabel(status) {
  return NOTIFY_LABEL[status] ?? String(status ?? '—');
}

/** 提交後的結果說明（SubmitSheet）。hasOrigin=false：不是從 CODD session 建立的（host token），本來就沒有 session 可通知 */
export function notifyResultText(notify, { hasOrigin = true } = {}) {
  const status = notify?.status;
  const label = notify?.session_label ? `「${notify.session_label}」` : '';
  if (!hasOrigin && (status === 'no_session' || status === 'none' || status == null)) {
    return '已提交並保存。這個 artifact 沒有對應的 session，請 Claude 用 artifact_read_submissions 讀取。';
  }
  switch (status) {
    case 'sent': return `已提交，並通知 session${label}。`;
    case 'pending': return `已提交。session${label}正在忙，閒置後會自動送出通知。`;
    case 'no_session': return '已提交。原本的 session 已經結束，提交已保存，Claude 之後可以用 artifact_read_submissions 讀取。';
    case 'disabled': return '已提交（沒有通知 session）。';
    case 'failed': return '已提交，但通知 session 失敗；提交已保存，可以在 session 裡請 Claude 讀取。';
    case 'expired': return '已提交，但等 session 閒置太久，沒有送出通知。';
    case 'skipped': return '已提交。Claude 已經讀過這次提交，不用再通知 session。';
    default: return '已提交。';
  }
}

/**
 * 留言點到的元素（target）→ 給 bridge 的定位資訊 { selector, rect }；沒有就回 null。
 * 頁面用內層容器捲動時（html, body 不捲、main 捲），文件座標跟內容脫鉤，bridge 用 selector 找到元素、
 * 照 x − rect.x 的相對位置把圓點 / highlight 放回元素上（selector 對不到唯一元素時退回 x / y）。
 */
export function targetAnchor(target) {
  if (!isObj(target) || typeof target.selector !== 'string' || !target.selector) return null;
  const r = target.rect;
  if (!isObj(r) || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return null;
  return { selector: target.selector, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

/** 一則留言的釘選標記（{ id, n, x, y, active }，有 target 就加上 selector / rect） */
export function pinOf(c, n, activeId = null) {
  const pin = { id: c.id, n, x: c.x, y: c.y, active: c.id === activeId };
  const a = targetAnchor(c.target);
  if (a) Object.assign(pin, a);
  return pin;
}

/** 某個 frame 的釘選標記：編號 = 全部留言依建立順序（陣列順序）的序號 */
export function pinsFor(comments, frameId, activeId = null) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((c, i) => {
    if (!isObj(c) || c.frame_id !== frameId) return;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
    out.push(pinOf(c, i + 1, activeId));
  });
  return out;
}

/** 字串的 UTF-8 位元組數（keepalive 的 64 KiB 上限算的是位元組，中文一個字 3 bytes） */
export function utf8Bytes(s) {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  let n = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** 草稿是不是空的（沒有任何會被提交的東西；空白留言 / 空白便利貼不算） */
export function isEmptyDraft(payload) {
  return payloadCounts(payload).empty;
}

/**
 * Claude 發布新版本時，把舊版本（還沒提交的）回覆帶到新版本的草稿。
 * - 給 Claude 的話：照帶。
 * - 留言：frame 在新版本還在的才帶（html kind 一律是 main）；空白的不帶。位置 / 點到的元素照舊（新版本的版面可能變了，
 *   但文字是重點）。
 * - 作答：題目 id 在新版本還在的才帶；選這個：frame 還在的才帶；便利貼（canvas）：有寫字的都帶。
 * - 頁面資料（window.codd.submit）：屬於舊版本的頁面，不帶。
 * 回傳 { payload, dropped: { comments, answers, selected, stickies, data } }（dropped 是沒帶過去的數量）。
 */
export function carryDraft(from, view, { kind } = {}) {
  const p = normalizeDraft(from);
  const isCanvas = (kind ?? view?.kind) === 'canvas';
  const frameIds = new Set(isCanvas
    ? (Array.isArray(view?.frames) ? view.frames : []).map((f) => f?.id).filter((id) => typeof id === 'string')
    : ['main']);
  const questionIds = new Set(isCanvas && Array.isArray(view?.questions)
    ? view.questions.map((q) => q?.id).filter((id) => typeof id === 'string')
    : []);
  const out = emptyPayload();
  out.message = p.message;

  const comments = p.comments.filter((c) => !isBlank(c.text));
  out.comments = comments.filter((c) => frameIds.has(c.frame_id)).slice(0, LIMITS.comments).map((c) => ({ ...c }));

  const answerKeys = Object.keys(p.answers).filter((k) => answered(p.answers[k]));
  for (const k of answerKeys) {
    if (!questionIds.has(k)) continue;
    const v = p.answers[k];
    out.answers[k] = Array.isArray(v) ? [...v] : v;
  }

  if (isCanvas) {
    out.selected = p.selected.filter((id) => frameIds.has(id));
    out.stickies = p.stickies.filter((s) => !isBlank(s.text)).slice(0, LIMITS.stickies).map((s) => ({ ...s }));
  }

  return {
    payload: out,
    dropped: {
      comments: comments.length - out.comments.length,
      answers: answerKeys.length - Object.keys(out.answers).length,
      selected: (isCanvas ? p.selected.length : 0) - out.selected.length,
      stickies: isCanvas ? p.stickies.filter((s) => !isBlank(s.text)).length - out.stickies.length : 0,
      data: p.data != null,
    },
  };
}

/**
 * 留言依 frame 分組（照 frames 的順序；不在 frames 裡的放最後一組）。
 * frames = [{ id, title }]；回傳 [{ frameId, title, items: [{ comment, n }] }]，空的組不回傳。
 */
export function groupComments(comments, frames) {
  const list = Array.isArray(comments) ? comments : [];
  const groups = new Map();
  for (const f of Array.isArray(frames) ? frames : []) {
    groups.set(f.id, { frameId: f.id, title: f.title || f.id, items: [] });
  }
  const orphans = { frameId: null, title: '（這個版本沒有對應的 frame）', items: [] };
  list.forEach((c, i) => {
    if (!isObj(c)) return;
    const g = groups.get(c.frame_id) ?? orphans;
    g.items.push({ comment: c, n: i + 1 });
  });
  const out = [...groups.values()].filter((g) => g.items.length);
  if (orphans.items.length) out.push(orphans);
  return out;
}

/**
 * 草稿自動儲存：schedule() 之後 delay ms 沒有新變更才送出；同一時間只有一個請求在跑，
 * 跑的期間又有變更就等它回來再送下一次。內容跟上一次存好的一樣就不送。
 *
 *   const saver = createDraftSaver({ save: (payload) => api.saveArtifactDraft(...), onStatus })
 *   saver.reset(payload)   // 載入 / 提交後：當成已儲存的基準，不送出
 *   saver.schedule(payload)
 *   await saver.flush()    // 離開頁面前：有排隊中的立刻送
 *   await saver.settle()   // 提交前：丟掉排隊中的、等進行中的回來（避免提交後草稿又被寫回去）
 *
 * status：'saved' | 'pending' | 'saving' | 'error'
 */
export function createDraftSaver({
  save,
  delay = 800,
  retryMs = 5000,
  maxRetryMs = 30000,
  isFatal = (err) => [400, 404, 409, 413].includes(err?.status),
  onStatus = () => {},
  timers = globalThis,
} = {}) {
  let baseline = null;   // 最後一次存好（或載入）的 JSON
  let pending = null;    // 等著送出的 JSON
  let timer = null;
  let inflight = null;
  let status = 'saved';
  let error = null;
  let retryDelay = retryMs;
  let disposed = false;

  function setStatus(next, err = null) {
    error = err;
    if (status === next && next !== 'error') return;
    status = next;
    onStatus(next, err);
  }

  function clearTimer() {
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
  }

  function arm(ms) {
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = null;
      run();
    }, ms);
  }

  function run() {
    if (disposed || pending == null) return inflight ?? Promise.resolve();
    if (inflight) return inflight; // 回來之後會看 pending 再送
    const json = pending;
    setStatus('saving');
    inflight = (async () => {
      try {
        await save(JSON.parse(json));
        baseline = json;
        retryDelay = retryMs;
        if (pending === json) pending = null;
      } catch (err) {
        if (disposed) return;
        setStatus('error', err);
        if (isFatal(err)) {
          pending = null;
        } else {
          arm(retryDelay);
          retryDelay = Math.min(maxRetryMs, retryDelay * 2);
        }
        return;
      } finally {
        inflight = null;
      }
      if (disposed) return;
      if (pending != null && pending !== baseline) {
        // 送出期間又改了：照常 debounce
        setStatus('pending');
        arm(delay);
      } else {
        pending = null;
        setStatus('saved');
      }
    })();
    return inflight;
  }

  return {
    get status() { return status; },
    get error() { return error; },
    get dirty() { return pending != null || inflight != null; },

    reset(payload) {
      clearTimer();
      pending = null;
      retryDelay = retryMs;
      baseline = payload === undefined ? null : JSON.stringify(payload);
      setStatus('saved');
    },

    schedule(payload) {
      if (disposed) return;
      const json = JSON.stringify(payload);
      if (json === baseline && !inflight) {
        // 改回跟已儲存的一樣：取消排隊中的
        clearTimer();
        pending = null;
        setStatus('saved');
        return;
      }
      if (json === pending && timer != null) return;
      pending = json;
      setStatus(inflight ? 'saving' : 'pending');
      arm(delay);
    },

    async flush() {
      clearTimer();
      if (inflight) await inflight;
      // 進行中的那次回來時可能又排了下一次（送出期間有新變更）：不等 debounce，直接送
      clearTimer();
      if (pending != null && pending !== baseline) await run();
    },

    async settle() {
      clearTimer();
      pending = null;
      if (inflight) await inflight.catch(() => {});
    },

    dispose() {
      disposed = true;
      clearTimer();
      pending = null;
    },
  };
}
