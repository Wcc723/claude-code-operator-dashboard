import { reactive } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';

// 終端機池：module 層 LRU，最多 3 個「活的」xterm + EventSource。
// 切換 session 時只把 host div 搬到可見容器（不重開、不重播），
// SessionDetail unmount（跳去 WORKSPACE 頁）再回來也沿用同一個 entry。

const MAX_LIVE = 3;
const INPUT_DEBOUNCE_MS = 10;
const MIN_COLS = 40;
const MIN_ROWS = 8;
// 與 server clamp 一致（terminal-manager: cols 20..500, rows 5..200），避免本地尺寸跟 PTY 對不上
const MAX_COLS = 500;
const MAX_ROWS = 200;
// 舊版 server（reset 沒帶 caughtup:true、不送 caughtup）的退路：reset 後這麼久內到的第一包當成重播
const CATCHUP_WINDOW_MS = 250;
// EventSource 放棄重連（非 200：Cloudflare 502/530、401…）後自己重試的退避
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
// 最近送出、還沒等到 size 回音的 resize（用來認出「同一個 client id 的別的分頁」）
const MAX_PENDING_CLAIMS = 4;
// 已結束的 session：ring 是空的就不會有 catch-up，最多等這麼久再關 stream
const EXITED_CLOSE_MS = 10000;

export const FONT_MIN = 10;
export const FONT_MAX = 24;
const FONT_KEY = 'codd.termFontSize';

const THEME = {
  background: '#000000',
  foreground: '#e8e6d8',
  cursor: '#ffb300',
};

export function isCoarsePointer() {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

function clampFont(n) {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

function loadFontSize() {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(n) && n > 0) return clampFont(n);
  } catch {}
  return isCoarsePointer() ? 14 : 15;
}

// 字級是「每台裝置」的偏好，所有 terminal 共用
export const termPrefs = reactive({ fontSize: loadFontSize() });

// HTTP/1.x（localhost、vite dev）每個 host 只有 6 條連線、所有分頁共用：
// 這時只讓畫面上那個 session 開著 SSE，切走就關、切回來重連重播（h2 / h3 的 Cloudflare 不受影響）
const SINGLE_STREAM = (() => {
  try {
    return /^http\/1/i.test(performance.getEntriesByType('navigation')[0]?.nextHopProtocol || '');
  } catch { return false; }
})();

const pool = new Map(); // Map 插入順序 = 使用順序（最舊在前）
let parking = null;
const textEncoder = new TextEncoder();

function bytesToBase64(bytes) {
  // 分段 fromCharCode，大段貼上時不用逐 byte 串字串
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  // atob 回傳 latin1 string（每個 char = 一個 byte 值）。
  // 直接 term.write(string) 會把 byte 當成 codepoint，UTF-8 multi-byte 會變成亂碼；
  // 轉 Uint8Array 餵給 xterm，它會自己 decode UTF-8。
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 不在畫面上的 host 停在這裡：仍在 DOM 內（字寬量測正常），但看不到也點不到
function parkingLot() {
  if (parking?.isConnected) return parking;
  parking = document.createElement('div');
  parking.setAttribute('aria-hidden', 'true');
  parking.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1200px;height:800px;' +
    'overflow:hidden;visibility:hidden;pointer-events:none;contain:strict;';
  document.body.appendChild(parking);
  return parking;
}

function create(id, clientId) {
  const host = document.createElement('div');
  host.className = 'codd-term-host';
  parkingLot().appendChild(host);

  const term = new Terminal({
    cursorBlink: false,
    convertEol: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: termPrefs.fontSize,
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const e = {
    id,
    clientId,
    term,
    fit,
    host,
    es: null,
    container: null,
    opened: false,
    disposed: false,
    quietFocus: false,
    // view 需要的狀態才放 reactive；term / es / host 不進 Vue 的 proxy
    state: reactive({
      stream: 'connecting', // connecting / live / reconnecting / closed
      ptySize: null,        // { cols, rows }，server 的 PTY 尺寸
      controllerId: null,   // 最後操作、控制 PTY 尺寸的 client
      follow: false,        // true = 依 PTY 尺寸顯示（容器捲動），false = 貼合容器
      exited: false,
      exitInfo: null,
    }),
    // 輸入：同一個 session 只有一條有序的送出佇列
    pending: '',
    inputTimer: null,
    queue: [],
    sending: false,
    // replay 期間 xterm 會對 ring buffer 裡的舊查詢（DA / DSR…）自動回應，不能送進 PTY
    replaying: false,
    awaitCatchup: false,
    markerMode: false,  // server 會在 catch-up 後送 caughtup
    replayGen: 0,       // 每次 reset +1：舊一輪的 write callback 不能清掉新一輪的 replaying
    caughtUp: false,
    resetAt: 0,
    closeTimer: null,
    retryTimer: null,
    retries: 0,
    claimRaf: 0,
    claims: [],         // 送出還沒收到回音的 { cols, rows }
    lastClaim: null,    // 最後一次送出的尺寸（收到回音後仍保留）
    foreign: false,     // 另一個分頁拿著同一個 client id 在控制：跟隨它，等這裡有人操作才搶回
  };

  // Alt+1..9 留給 app 的切換 session 快捷鍵；其他按鍵視為「這台在操作」
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.altKey && /^Digit[1-9]$/.test(ev.code)) return false;
    if (ev.type === 'keydown') interact(e);
    return true;
  });

  // xterm 把所有按鍵（含 arrow keys / Ctrl-C / Tab / IME 中文）轉成正確的 byte sequence 給 onData；
  // 10ms debounce 合併同一輪的 keystroke，避免太多小 POST 又不會感覺延遲
  term.onData((s) => {
    if (e.replaying || e.state.exited) return;
    e.pending += s;
    if (!e.inputTimer) e.inputTimer = setTimeout(() => flushPending(e), INPUT_DEBOUNCE_MS);
  });

  connect(e);
  return e;
}

function connect(e) {
  if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; }
  if (e.es) e.es.close();
  const es = new EventSource(`/api/terminal/sessions/${e.id}/stream`, { withCredentials: true });
  e.es = es;
  e.state.stream = 'connecting';

  const finishReplay = (gen) => {
    if (gen !== e.replayGen) return;
    e.replaying = false;
    e.caughtUp = true;
    if (e.state.exited) closeStream(e);
  };

  // EventSource 自動重連時 server 會重送 reset + size + 完整 catch-up：先清畫面才不會疊兩份
  es.addEventListener('reset', (ev) => {
    let p = null;
    try { p = JSON.parse(ev.data); } catch {}
    e.state.stream = 'live';
    e.retries = 0;
    e.term.reset();
    e.replayGen += 1;
    e.claims = [];
    e.awaitCatchup = true;
    e.caughtUp = false;
    // 有 caughtup 標記就不靠時間差：慢速連線收完幾 MB 的 catch-up 要好幾秒，期間全部當重播
    e.markerMode = p?.caughtup === true;
    e.replaying = e.markerMode;
    e.resetAt = performance.now();
  });

  es.addEventListener('caughtup', () => {
    e.awaitCatchup = false;
    const gen = e.replayGen;
    // write('') 的 callback 排在前面所有 catch-up 資料 parse 完之後
    e.term.write('', () => finishReplay(gen));
  });

  es.addEventListener('size', (ev) => {
    let p;
    try { p = JSON.parse(ev.data); } catch { return; }
    const cols = Number(p?.cols);
    const rows = Number(p?.rows);
    if (!cols || !rows) return;
    const clientId = p.client_id ?? null;
    let waitEcho = false;
    if (clientId && clientId === e.clientId) {
      const i = e.claims.findIndex((c) => c.cols === cols && c.rows === rows);
      if (i >= 0) {
        e.claims.splice(0, i + 1);
        // 還有更新的 resize 在路上：等它的回音再對齊，不然會把舊尺寸當成要再搶一次
        waitEcho = e.claims.length > 0;
      } else if (e.lastClaim && (e.lastClaim.cols !== cols || e.lastClaim.rows !== rows)) {
        // 同一個 client id、卻不是這裡送出的尺寸 = 另一個分頁（複製分頁會連 sessionStorage 一起複製）：
        // 跟著它、不搶回來，否則兩邊會無限互相 resize
        e.foreign = true;
      }
    }
    e.state.ptySize = { cols, rows };
    e.state.controllerId = clientId;
    if (e.container) { if (!waitEcho) sync(e); }
    // 停車中的 entry 也要跟上 PTY 尺寸，之後的輸出（含重連重播）才不會用舊的寬度 parse
    else resizeTerm(e, Math.min(MAX_COLS, Math.max(1, cols)), Math.min(MAX_ROWS, Math.max(1, rows)));
  });

  es.addEventListener('data', (ev) => {
    e.state.stream = 'live';
    let bytes;
    try { bytes = base64ToBytes(ev.data); } catch { return; }
    if (e.awaitCatchup && !e.markerMode) {
      e.awaitCatchup = false;
      if (performance.now() - e.resetAt < CATCHUP_WINDOW_MS) {
        const gen = e.replayGen;
        e.replaying = true;
        e.term.write(bytes, () => finishReplay(gen));
        return;
      }
    }
    if (!e.awaitCatchup) e.caughtUp = true;
    e.term.write(bytes);
  });

  es.addEventListener('exit', (ev) => {
    let payload = {};
    try { payload = JSON.parse(ev.data) ?? {}; } catch {}
    e.term.write(`\r\n\x1b[33m[session exited: code=${payload.exitCode ?? 'n/a'} signal=${payload.signal ?? 'n/a'}]\x1b[0m\r\n`);
    e.state.exitInfo = payload;
    e.state.exited = true;
    closeStream(e);
    sync(e);
  });

  es.onerror = () => {
    if (e.es !== es) return;
    // 非 200（Cloudflare 502/530、401、404）時 EventSource 不會自己重連：排一次退避重試
    if (es.readyState === EventSource.CLOSED) {
      e.state.stream = 'closed';
      scheduleReconnect(e);
    } else if (e.state.stream !== 'closed') e.state.stream = 'reconnecting';
  };
}

function needsStream(e) {
  return !e.disposed && !e.state.exited && (!e.es || e.es.readyState === EventSource.CLOSED);
}

function scheduleReconnect(e) {
  if (e.retryTimer || !needsStream(e)) return;
  if (SINGLE_STREAM && !e.container) return; // 停車中不佔連線，attach 時再接
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(e.retries, 5));
  e.retries += 1;
  e.retryTimer = setTimeout(async () => {
    e.retryTimer = null;
    if (!needsStream(e)) return;
    try {
      // 先探一下：404 = session 不在了（server 重啟過）、401 = 登入過期（api.js 會通知 App），都不再重試
      await api.getSession(e.id);
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 401) scheduleReconnect(e);
      return;
    }
    if (needsStream(e) && !e.retryTimer) connect(e);
  }, delay);
}

function closeStream(e) {
  if (e.closeTimer) { clearTimeout(e.closeTimer); e.closeTimer = null; }
  if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; }
  if (e.es) { e.es.close(); e.es = null; }
  e.state.stream = 'closed';
}

function proposeDims(e) {
  const d = e.fit.proposeDimensions();
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, d.cols)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, d.rows)),
  };
}

function setFollow(e, on) {
  e.state.follow = on;
  e.host.classList.toggle('is-follow', on);
}

function resizeTerm(e, cols, rows) {
  if (e.term.cols !== cols || e.term.rows !== rows) e.term.resize(cols, rows);
}

// 依容器貼合本地尺寸（不通知 server）
function fitLocal(e) {
  setFollow(e, false);
  // 從跟隨模式切回來時，舊的大尺寸會讓容器出現捲軸、量到偏小（xterm 下一個 frame 才縮）：
  // 量的當下先關掉容器捲動
  const vp = e.container;
  const prevOverflow = vp.style.overflow;
  vp.style.overflow = 'hidden';
  const d = proposeDims(e);
  vp.style.overflow = prevOverflow;
  if (d) resizeTerm(e, d.cols, d.rows);
  return d;
}

// 另一台裝置在控制：照 PTY 尺寸顯示，容器負責捲動
function follow(e) {
  setFollow(e, true);
  const p = e.state.ptySize;
  if (p) resizeTerm(e, p.cols, p.rows);
}

// 取得 PTY 尺寸控制權：貼合本機容器，尺寸或 controller 不同才 POST
function claimEntry(e) {
  if (!e.container || !e.opened || e.disposed) return;
  if (e.state.exited) { sync(e); return; }
  e.foreign = false;
  const d = fitLocal(e);
  if (!d) return;
  const s = e.state;
  if (s.controllerId === e.clientId && s.ptySize?.cols === d.cols && s.ptySize?.rows === d.rows) return;
  const prev = { controllerId: s.controllerId, ptySize: s.ptySize };
  // 先樂觀更新：連續按鍵時只送一次；之後 server 的 size 事件才是最終答案
  s.controllerId = e.clientId;
  s.ptySize = { ...d };
  const claim = { cols: d.cols, rows: d.rows };
  const prevClaim = e.lastClaim;
  e.lastClaim = claim;
  e.claims.push(claim);
  if (e.claims.length > MAX_PENDING_CLAIMS) e.claims.shift();
  api.resizeSession(e.id, { cols: d.cols, rows: d.rows, client_id: e.clientId }).catch(() => {
    const i = e.claims.indexOf(claim);
    if (i >= 0) e.claims.splice(i, 1);
    if (e.lastClaim === claim) e.lastClaim = prevClaim;
    if (s.controllerId === e.clientId && s.ptySize?.cols === d.cols && s.ptySize?.rows === d.rows) {
      s.controllerId = prev.controllerId;
      s.ptySize = prev.ptySize;
    }
  });
}

function sync(e) {
  if (!e.container || !e.opened || e.disposed) return;
  const s = e.state;
  if (s.ptySize && (s.exited || e.foreign || (s.controllerId && s.controllerId !== e.clientId))) follow(e);
  else if (s.ptySize) claimEntry(e);
  // 還沒收到 size 事件：先貼合畫面，等 size 再決定要不要 claim
  else fitLocal(e);
}

function interact(e) {
  if (!e.container || e.state.exited) return;
  // 已經是自己在控制就不用每個按鍵都量一次尺寸（容器變化交給 ResizeObserver）
  if (e.state.controllerId === e.clientId && !e.state.follow) return;
  claimEntry(e);
}

function flushPending(e) {
  if (e.inputTimer) { clearTimeout(e.inputTimer); e.inputTimer = null; }
  if (!e.pending) return;
  const s = e.pending;
  e.pending = '';
  enqueue(e, s).catch((err) => {
    // session 已 exit / 網路問題：靜默；畫面上的 stream 狀態 / exited banner 會反映
    console.warn('[input] send failed:', err.message);
  });
}

function enqueue(e, str) {
  return new Promise((resolve, reject) => {
    e.queue.push({ str, resolve, reject });
    pump(e);
  });
}

// 一次只有一個 POST 在飛；飛行中累積的輸入合併成下一個 POST，順序不會亂
async function pump(e) {
  if (e.sending) return;
  e.sending = true;
  try {
    while (e.queue.length) {
      const batch = e.queue.splice(0);
      if (e.disposed) {
        batch.forEach((b) => b.reject(new Error('terminal closed')));
        continue;
      }
      try {
        const b64 = bytesToBase64(textEncoder.encode(batch.map((b) => b.str).join('')));
        await api.sendSessionInput(e.id, b64);
        batch.forEach((b) => b.resolve());
      } catch (err) {
        batch.forEach((b) => b.reject(err));
      }
    }
  } finally {
    e.sending = false;
  }
}

function wireDom(e) {
  e.host.addEventListener('paste', () => interact(e), true);
  e.term.textarea?.addEventListener('focus', () => {
    if (!e.quietFocus) interact(e);
  });
}

function dispose(e) {
  if (e.disposed) return;
  flushPending(e);
  e.disposed = true;
  if (e.inputTimer) clearTimeout(e.inputTimer);
  if (e.claimRaf) cancelAnimationFrame(e.claimRaf);
  closeStream(e);
  try { e.term.dispose(); } catch {}
  e.host.remove();
}

function evict() {
  // 先踢已結束的，再照 LRU；正在畫面上的不踢
  const order = [...pool.values()].filter((e) => !e.container);
  order.sort((a, b) => Number(b.state.exited) - Number(a.state.exited));
  for (const e of order) {
    if (pool.size <= MAX_LIVE) break;
    pool.delete(e.id);
    dispose(e);
  }
}

// ───────────────────────── public API ─────────────────────────

export function acquire(id, clientId) {
  let e = pool.get(id);
  if (e) {
    pool.delete(id);
    pool.set(id, e);
    e.clientId = clientId;
    return e;
  }
  e = create(id, clientId);
  pool.set(id, e);
  evict();
  return e;
}

export function attach(id, container, { focus = false } = {}) {
  const e = pool.get(id);
  if (!e || !container) return null;
  e.container = container;
  if (e.host.parentNode !== container) container.appendChild(e.host);
  // stream 已放棄（或 HTTP/1.x 下切走時關掉了）：回到畫面就重接，server 會 reset + 重播
  if (needsStream(e)) connect(e);
  if (!e.opened) {
    // open 只做一次：之後一律搬 host，不重開
    e.term.open(e.host);
    e.opened = true;
    wireDom(e);
  }
  if (e.term.options.fontSize !== termPrefs.fontSize) e.term.options.fontSize = termPrefs.fontSize;
  sync(e);
  e.term.refresh(0, e.term.rows - 1);
  if (focus) focusQuietly(e);
  return e;
}

export function detach(id, container) {
  const e = pool.get(id);
  if (!e || (container && e.container !== container)) return;
  e.container = null;
  e.term.blur();
  parkingLot().appendChild(e.host);
  if (SINGLE_STREAM && !e.state.exited) closeStream(e);
  evict();
}

function focusQuietly(e) {
  e.quietFocus = true;
  try { e.term.focus(); } finally { e.quietFocus = false; }
}

export function focus(id) {
  const e = pool.get(id);
  if (e?.opened) e.term.focus();
}

export function claim(id) {
  const e = pool.get(id);
  if (e) claimEntry(e);
}

// ResizeObserver（已 debounce）呼叫：自己控制時重新貼合並通知 server，跟隨模式下讓容器捲動
export function containerResized(id) {
  const e = pool.get(id);
  if (e) sync(e);
}

export function markExited(id) {
  const e = pool.get(id);
  if (!e || e.state.exited) return;
  e.state.exited = true;
  // 已結束的 session server 不會再送 exit：catch-up 收完就關 stream，不佔連線
  if (e.es) {
    if (e.caughtUp && !e.replaying) closeStream(e);
    else if (!e.closeTimer) e.closeTimer = setTimeout(() => closeStream(e), EXITED_CLOSE_MS);
  }
  sync(e);
}

// 換了 client id（偵測到複製分頁）：所有 entry 改用新的 id，舊 id 的控制權不再算自己的
export function setClientId(clientId) {
  for (const e of pool.values()) {
    if (e.clientId === clientId) continue;
    e.clientId = clientId;
    e.claims = [];
    e.lastClaim = null;
    e.foreign = false;
    if (e.container) sync(e);
  }
}

export function setFontSize(n) {
  const size = clampFont(n);
  termPrefs.fontSize = size;
  try { localStorage.setItem(FONT_KEY, String(size)); } catch {}
  for (const e of pool.values()) {
    if (!e.container || !e.opened) continue;
    e.term.options.fontSize = size;
    // 字寬量測在下一個 frame 才穩定，再貼合 + 取得控制權
    if (e.claimRaf) cancelAnimationFrame(e.claimRaf);
    e.claimRaf = requestAnimationFrame(() => {
      e.claimRaf = 0;
      claimEntry(e);
    });
  }
}

// xterm 鍵盤以外的輸入（KeyBar / Composer）：先送出 debounce 中的按鍵，再排進同一條佇列
export function sendText(id, str) {
  const e = pool.get(id);
  if (!e || e.disposed) {
    return api.sendSessionInput(id, bytesToBase64(textEncoder.encode(str)));
  }
  flushPending(e);
  return enqueue(e, str);
}

// KeyBar 的方向鍵：app 開了 application cursor mode（DECCKM）時要送 ESC O x，跟實體鍵盤一致
export function sendKey(id, seq) {
  const e = pool.get(id);
  let out = seq;
  if (e?.term.modes.applicationCursorKeysMode && /^\x1b\[[ABCD]$/.test(seq)) out = `\x1bO${seq[2]}`;
  return sendText(id, out);
}

// 游標那一行底部相對 host 的像素位置：跟隨模式下讓容器捲到 prompt 附近
export function cursorBottomPx(id) {
  const e = pool.get(id);
  const screen = e?.host.querySelector('.xterm-screen');
  if (!e?.opened || !screen || !e.term.rows) return null;
  const cellH = screen.offsetHeight / e.term.rows;
  return (e.term.buffer.active.cursorY + 1) * cellH;
}

export function stateOf(id) {
  return pool.get(id)?.state ?? null;
}

export function release(id) {
  const e = pool.get(id);
  if (!e) return;
  pool.delete(id);
  dispose(e);
}

export function releaseAll() {
  for (const id of [...pool.keys()]) release(id);
}
