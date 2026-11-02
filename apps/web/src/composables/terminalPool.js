import { reactive } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';
import { pickScrollMode } from '../lib/terminal-touch.js';
import { textLinksAtRow, scanTextLinks, overlapsRanges, mergeLinkList, rangeContains, webTarget, displayUrl } from '../lib/terminal-links.js';

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
// OSC 8 連結跨好幾行（Ink 硬換行）時，往上 / 往下最多找幾行同一個網址（⌘ / Ctrl+點時比對畫面上的字）
const MAX_OSC_JOIN_ROWS = 16;
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

  // e 在下面才建立；這些 callback 只會在之後（滑鼠 / 解析輸出時）被呼叫
  let e = null;
  const term = new Terminal({
    cursorBlink: false,
    convertEol: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: termPrefs.fontSize,
    theme: THEME,
    scrollback: 5000,
    // Claude Code 開著滑鼠追蹤時，Mac 上一般拖曳會變成滑鼠事件送給它；按住 Option 拖曳改成選取文字（再 ⌘C 複製）。
    // 其他平台是 Shift 拖曳（xterm 預設）
    macOptionClickForcesSelection: true,
    // Option+點一下預設會用方向鍵把游標移過去：app 開著滑鼠追蹤（Claude Code）時會送進幾千個方向鍵。
    // 預設關掉；沒開滑鼠追蹤（一般 shell）時在 mousedown 當下打開（wireDom），維持原本的行為
    altClickMovesCursor: false,
    // OSC 8 超連結：不用 xterm 預設的 window.confirm（英文、會卡住頁面），交給 TerminalPane 的連結面板。
    // 非 http(s) 的也收（file:// 之類），面板只給「複製」；真正開網頁的只有 lib/link-actions.js 的 openWebUrl
    linkHandler: {
      activate: (ev, text, range) => xtermActivated(e, { url: text, osc: true, range }, ev),
      // 滑鼠停在連結上：提示真正會去哪裡（OSC 8 畫面上的字可以跟網址不一樣）
      hover: (ev, text) => showLinkHint(e, text),
      leave: () => clearLinkHint(e),
      allowNonHttpProtocols: true,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  e = {
    id,
    clientId,
    term,
    fit,
    host,
    linkProvider: null,
    oscSeen: 0,           // 看過幾個 OSC 8（0 = 這個 session 沒有，連結清單 / 重疊檢查不用問 OSC 8）
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
      scrolledUp: false,    // 終端機往上捲、沒在看最新輸出（顯示「↓ 最新」）
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

  // 純文字網址（xterm 只認 OSC 8）：hover 畫底線、點擊交給 TerminalPane。
  // xterm 依註冊順序排優先：OSC 8 的 provider 在 xterm 建構時就註冊，排在這個前面，同一格以 OSC 8 為準。
  // 蓋到 OSC 8 格子的純文字網址整個不算（OSC 8 自己帶真正的網址）：OSC 8 連結後面接著網址字元、
  // 或 OSC 8 連結剛好寫到行尾被硬換行規則接到下一行的字，都不會多出一個錯的連結
  e.linkProvider = {
    provideLinks(y, callback) {
      let links = [];
      try {
        const b = term.buffer.active;
        links = textLinksAtRow((r) => b.getLine(r), y - 1, b.length, term.cols, b.getNullCell());
        if (links.length && e.oscSeen) {
          const oscRows = new Map();
          links = links.filter((l) => !coveredByOsc(e, l.segments, oscRows));
        }
      } catch { links = []; }
      callback(links.length ? links.map((l) => ({
        text: l.url,
        range: l.range,
        activate: (ev, text) => xtermActivated(e, { url: text, osc: false, range: l.range }, ev),
        hover: (ev, text) => showLinkHint(e, text),
        leave: () => clearLinkHint(e),
      })) : undefined);
    },
  };
  term.registerLinkProvider(e.linkProvider);
  // 不攔 OSC 8（回傳 false，xterm 照常處理），只數有沒有出現過（不留網址本身）
  term.parser.registerOscHandler(8, (data) => {
    const i = data.indexOf(';');
    if (i >= 0 && i < data.length - 1) e.oscSeen += 1;
    return false;
  });

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

  // 「↓ 最新」按鈕：使用者捲動、新輸出、切換 alt buffer、改尺寸都可能改變是否在最底下
  const updateScrolled = () => {
    const b = e.term.buffer.active;
    const up = b.viewportY < b.baseY;
    if (e.state.scrolledUp !== up) e.state.scrolledUp = up;
  };
  term.onScroll(updateScrolled);
  term.onWriteParsed(updateScrolled);
  term.onResize(updateScrolled);
  term.buffer.onBufferChange(updateScrolled);

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
  // 在 xterm 之前（capture）：沒開滑鼠追蹤時 Option+點一下照舊移動游標，開著時不移（見 Terminal 的 altClickMovesCursor）
  e.host.addEventListener('mousedown', () => {
    const want = e.term.modes.mouseTrackingMode === 'none';
    if (e.term.options.altClickMovesCursor !== want) e.term.options.altClickMovesCursor = want;
  }, true);
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

export function focus(id, { quiet = false } = {}) {
  const e = pool.get(id);
  if (!e?.opened) return;
  if (quiet) focusQuietly(e);
  else e.term.focus();
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

// ───── 觸控捲動（lib/terminal-touch.js）─────
// 每次手勢開始時拿一份；方法每次都重新查 entry，切走或被踢掉後就變成 no-op。
// 這裡刻意不呼叫 interact()：捲動只是在看，不算「這台在操作」，不搶 PTY 尺寸。

function liveEntry(id) {
  const e = pool.get(id);
  return e && e.opened && !e.disposed && e.container ? e : null;
}

function cellHeightOf(e) {
  const screen = e.host.querySelector('.xterm-screen');
  const h = screen && e.term.rows ? screen.offsetHeight / e.term.rows : 0;
  return h > 0 ? h : Math.round(e.term.options.fontSize * 1.2);
}

export function touchTarget(id) {
  return {
    mode() {
      const e = liveEntry(id);
      if (!e) return 'none';
      return pickScrollMode({
        alt: e.term.buffer.active.type === 'alternate',
        mouseTracking: e.term.modes.mouseTrackingMode,
      });
    },
    cellHeight() {
      const e = liveEntry(id);
      return e ? cellHeightOf(e) : 0;
    },
    // 回傳實際捲了幾行（到頂 / 到底時會比要求的少）
    scrollLines(n) {
      const e = liveEntry(id);
      if (!e || !n) return 0;
      const b = e.term.buffer.active;
      const to = Math.min(b.baseY, Math.max(0, b.viewportY + n));
      const moved = to - b.viewportY;
      if (moved) e.term.scrollLines(moved);
      return moved;
    },
    canScroll(dir) {
      const e = liveEntry(id);
      if (!e) return false;
      const b = e.term.buffer.active;
      return dir < 0 ? b.viewportY > 0 : dir > 0 ? b.viewportY < b.baseY : false;
    },
    // app 開了滑鼠追蹤：每一行送一個滾輪事件給 xterm，由它編成 wheel report 送進 PTY（走 onData 那條佇列）
    wheel(lines, x, y) {
      const e = liveEntry(id);
      const el = e?.term.element;
      const screen = el?.querySelector('.xterm-screen');
      if (!screen || !lines) return;
      const r = screen.getBoundingClientRect();
      const cx = Math.min(Math.max(x, r.left + 1), r.right - 1);
      const cy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
      const sign = Math.sign(lines);
      for (let i = 0; i < Math.abs(lines); i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaY: sign,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: cx,
          clientY: cy,
          bubbles: true,
          cancelable: true,
        }));
      }
    },
  };
}

// ───── 連結（lib/terminal-links.js 找、TerminalPane 的連結面板開 / 複製）─────

const linkListeners = new Set();

/** 訂閱「xterm 自己觸發的連結點擊」（OSC 8 / 純文字網址）；回傳取消訂閱 */
export function onLinkActivate(fn) {
  linkListeners.add(fn);
  return () => linkListeners.delete(fn);
}

// xterm 的 Linkifier 在 mouseup 時觸發。一般點擊 TerminalPane 已經處理了（mousedown 攔下，或沒開滑鼠追蹤時在 mouseup 開），
// 這裡是退路；Shift / Alt 是在選取文字，右鍵 / 中鍵照舊交給 app，都不當成點連結
function xtermActivated(e, info, ev) {
  if (!e || e.disposed || ev?.shiftKey || ev?.altKey) return;
  if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
  for (const fn of linkListeners) {
    try { fn({ id: e.id, ...info, event: ev ?? null }); } catch (err) { console.warn('[links]', err?.message || err); }
  }
}

// xterm 內部的 link provider 清單（第一個是 OSC 8）。是私有 API：拿不到就退回只看純文字網址
function linkProvidersOf(e) {
  try {
    const list = e.term._core?._linkProviderService?.linkProviders;
    if (Array.isArray(list) && list.includes(e.linkProvider)) return list;
  } catch {}
  return null;
}

// OSC 8 的 provider（xterm 內建、不是自己註冊的那個）
function oscProvidersOf(e) {
  const list = linkProvidersOf(e);
  return list ? list.filter((p) => p !== e.linkProvider) : [];
}

// 第 y 行（0-based）的 OSC 8 連結（provideLinks 是同步回呼）
function oscLinksAt(e, y, providers = oscProvidersOf(e)) {
  const out = [];
  for (const p of providers) {
    let got = null;
    try { p.provideLinks(y + 1, (links) => { got = links; }); } catch { got = null; }
    if (got?.length) for (const l of got) if (typeof l?.text === 'string' && l.range) out.push(l);
  }
  return out;
}

// 純文字網址的格子有沒有蓋到 OSC 8 連結；cache = 這一輪已經問過的行
function coveredByOsc(e, segments, cache) {
  const providers = oscProvidersOf(e);
  if (!providers.length) return false;
  for (const s of segments) {
    if (!cache.has(s.y)) cache.set(s.y, oscLinksAt(e, s.y, providers).map((l) => l.range));
    const ranges = cache.get(s.y);
    if (ranges.length && overlapsRanges([s], ranges, e.term.cols)) return true;
  }
  return false;
}

// 滑鼠停在連結上的提示（瀏覽器原生 tooltip）：主機 + 網址（看不見的字元換掉、太長截斷），只用文字
const HINT_URL_CHARS = 200;
function showLinkHint(e, url) {
  const screen = e && !e.disposed ? screenOf(e) : null;
  if (!screen || typeof url !== 'string') return;
  const t = webTarget(url);
  const shown = displayUrl(url, HINT_URL_CHARS).text;
  screen.title = t ? `前往 ${t.host}\n${shown}\n（點一下：開啟 / 複製）` : `${shown}\n（不是網頁連結，點一下可以複製）`;
}
function clearLinkHint(e) {
  const screen = e && !e.disposed ? screenOf(e) : null;
  if (screen?.hasAttribute('title')) screen.removeAttribute('title');
}

function screenOf(e) {
  return e.term.element?.querySelector('.xterm-screen') || null;
}

// 畫面座標 → buffer 的格子（0-based）
function cellAt(e, clientX, clientY) {
  const screen = screenOf(e);
  if (!screen || !e.term.cols || !e.term.rows) return null;
  const r = screen.getBoundingClientRect();
  if (!(clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom)) return null;
  const x = Math.min(e.term.cols - 1, Math.floor((clientX - r.left) / (r.width / e.term.cols)));
  const row = Math.min(e.term.rows - 1, Math.floor((clientY - r.top) / (r.height / e.term.rows)));
  return { x, y: e.term.buffer.active.viewportY + row };
}

/** 事件的 target 是不是終端機的文字區（不是捲軸、不是疊在上面的按鈕） */
export function isTerminalScreen(id, target) {
  const e = liveEntry(id);
  const screen = e && screenOf(e);
  return !!screen && !!target && screen.contains(target);
}

/**
 * 畫面上這一點的連結：先問 OSC 8、再問純文字網址（跟 xterm hover 的優先順序一樣）。
 * @returns {null | { url: string, osc: boolean, range: object }}
 */
export function linkAtPoint(id, clientX, clientY) {
  const e = liveEntry(id);
  if (!e) return null;
  const pos = cellAt(e, clientX, clientY);
  if (!pos) return null;
  const providers = linkProvidersOf(e) || [e.linkProvider];
  for (const p of providers) {
    let got = null;
    try { p.provideLinks(pos.y + 1, (links) => { got = links; }); } catch { got = null; }
    const hit = got?.find((l) => l?.range && rangeContains(l.range, pos.x, pos.y, e.term.cols));
    if (hit && typeof hit.text === 'string') return { url: hit.text, osc: p !== e.linkProvider, range: hit.range };
  }
  return null;
}

/** 連結第一行在畫面上的位置（桌面浮層定位用）；不在畫面上回傳 null */
export function linkRect(id, range) {
  const e = liveEntry(id);
  const screen = e && screenOf(e);
  if (!screen || !range) return null;
  const r = screen.getBoundingClientRect();
  const cw = r.width / e.term.cols;
  const ch = r.height / e.term.rows;
  const row = range.start.y - 1 - e.term.buffer.active.viewportY;
  if (row < 0 || row >= e.term.rows) return null;
  const top = r.top + row * ch;
  const left = r.left + (range.start.x - 1) * cw;
  const right = range.end.y === range.start.y ? r.left + range.end.x * cw : r.right;
  return { left, right, top, bottom: top + ch };
}

/**
 * 這個 session 的 buffer（捲動紀錄 + 畫面）裡的連結：越新越前面、不重複、最多 50 筆。
 * 開清單時才算（5000 行捲動紀錄約數毫秒）。
 * @returns {{ url: string, osc: boolean }[]}
 */
export function listLinks(id) {
  const e = pool.get(id);
  if (!e || e.disposed) return [];
  const buf = e.term.buffer.active;
  const cols = e.term.cols;
  const total = buf.length;
  const items = [];
  const oscByRow = new Map(); // y → OSC 8 的 range（純文字網址蓋到的不算）
  const providers = linkProvidersOf(e);
  if (providers && e.oscSeen) {
    for (const p of providers) {
      if (p === e.linkProvider) continue;
      for (let y = 0; y < total; y++) {
        let got = null;
        try { p.provideLinks(y + 1, (links) => { got = links; }); } catch { got = null; }
        if (!got?.length) continue;
        for (const l of got) {
          if (typeof l?.text !== 'string' || !l.range) continue;
          items.push({ url: l.text, y: l.range.start.y - 1, x: l.range.start.x - 1, osc: true });
          for (let r = l.range.start.y - 1; r <= l.range.end.y - 1; r++) {
            if (!oscByRow.has(r)) oscByRow.set(r, []);
            oscByRow.get(r).push(l.range);
          }
        }
      }
    }
  }
  for (const t of scanTextLinks((y) => buf.getLine(y), total, cols, buf.getNullCell())) {
    const ranges = t.segments.flatMap((s) => oscByRow.get(s.y) || []);
    if (ranges.length && overlapsRanges(t.segments, ranges, cols)) continue;
    items.push({ url: t.url, y: t.y, x: t.x, osc: false });
  }
  return mergeLinkList(items);
}

// 連結那幾行目前的字（判斷連結有沒有被捲走 / 改寫）
function rowsText(buf, range) {
  const y0 = range.start.y - 1;
  const y1 = Math.min(range.end.y - 1, y0 + MAX_OSC_JOIN_ROWS);
  let out = '';
  for (let y = y0; y <= y1; y++) out += (buf.getLine(y)?.translateToString(false) ?? '') + '\n';
  return out;
}

/**
 * 連結在畫面上移動了（使用者捲動、新輸出把它推走、Claude Code 的捲動區域把那幾行改寫、換 buffer、改尺寸）時通知。
 * 只是有新輸出、但使用者往上捲著看、連結沒動：不通知（浮層不會一有輸出就關掉）。
 * @returns {() => void} 取消訂閱
 */
export function onLinkMoved(id, range, fn) {
  const e = pool.get(id);
  if (!e || e.disposed || !range) return () => {};
  const snap = () => {
    const b = e.term.buffer.active;
    return `${b.type}|${b.viewportY}|${rowsText(b, range)}`;
  };
  const start = snap();
  let raf = 0;
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    fn();
  };
  const check = () => {
    raf = 0;
    if (!done && snap() !== start) fire();
  };
  // 輸出很密時（Claude Code 的 spinner）一個 frame 只比一次
  const schedule = () => { if (!raf && !done) raf = requestAnimationFrame(check); };
  const subs = [
    e.term.onScroll(schedule),
    e.term.onWriteParsed(schedule),
    e.term.onResize(fire),
    e.term.buffer.onBufferChange(fire),
  ];
  return () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    for (const d of subs) { try { d.dispose(); } catch {} }
  };
}

/** 有沒有選取文字（拖曳 / 雙擊選字之後不要再開連結面板） */
export function hasSelection(id) {
  const e = liveEntry(id);
  try { return !!e && e.term.hasSelection(); } catch { return false; }
}

/** app 開的滑鼠追蹤模式（'none' = 沒開：一般 shell，點擊、拖曳由 xterm 自己處理） */
export function mouseTracking(id) {
  const e = liveEntry(id);
  return e ? e.term.modes.mouseTrackingMode : 'none';
}

/**
 * 連結在畫面上的字（⌘ / Ctrl+點時比對「看到的」跟「真正要去的」）。
 * OSC 8：被 Ink 硬換行切開的同一個連結，把上下相鄰幾行的那一段也接起來。純文字網址：就是網址本身。
 */
export function linkVisibleText(id, hit) {
  const e = liveEntry(id);
  if (!e || !hit?.range) return '';
  if (!hit.osc) return hit.url;
  const buf = e.term.buffer.active;
  const piece = (r) => buf.getLine(r.start.y - 1)?.translateToString(false, r.start.x - 1, r.end.x) ?? '';
  const providers = oscProvidersOf(e);
  const y = hit.range.start.y - 1;
  let text = piece(hit.range);
  for (let r = y - 1, n = 0; r >= 0 && n < MAX_OSC_JOIN_ROWS; r--, n++) {
    const same = oscLinksAt(e, r, providers).filter((l) => l.text === hit.url);
    if (!same.length) break;
    text = piece(same[same.length - 1].range).trimEnd() + text.trimStart();
  }
  for (let r = hit.range.end.y, n = 0; r < buf.length && n < MAX_OSC_JOIN_ROWS; r++, n++) {
    const same = oscLinksAt(e, r, providers).filter((l) => l.text === hit.url);
    if (!same.length) break;
    text = text.trimEnd() + piece(same[0].range).trimStart();
  }
  return text.trim();
}

// 「↓ 最新」：回到最新輸出
export function scrollToBottom(id) {
  const e = pool.get(id);
  if (e?.opened && !e.disposed) e.term.scrollToBottom();
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
