// artifact frame 的 parent 端 postMessage helper（協定見 ARTIFACT 規格 §6）。
//
// iframe 是 sandbox（沒有 allow-same-origin，origin 是 opaque 的 "null"），所以：
// - 送出只能用 targetOrigin '*'，但只送給「這個 iframe 的 contentWindow」。
// - 收到的訊息不能看 origin（永遠是 "null"），改成只認 event.source === iframe.contentWindow，
//   再檢查 codd: 1、type、frameId 與每個欄位的型別 / 大小；不合格的一律安靜丟掉。
// - iframe 重新載入（換版本、使用者在 frame 裡點了連結回來…）會再送一次 ready，
//   這時自動把目前的 pick-mode、pins、highlight 重送，呼叫端不用自己記。
// - 規格 §6 以外的選用訊息 `wheel`（frame → parent，只在 Ctrl + 滾輪、也就是觸控板 pinch 時送）：
//   { frameId, clientX, clientY, deltaX, deltaY, deltaMode, ctrlKey: true }。
//   frame 裡的 pinch 事件 parent 收不到，畫布就沒辦法縮放；所以 forwardZoom: true 時（canvas）
//   parent 送 { type: 'zoom-forward', on: true }，bridge 才攔下 Ctrl + 滾輪（不讓瀏覽器縮放整頁）轉成 wheel。
//   zoom-forward 開著時另外轉送 frame 裡的兩指觸控 pinch 與 Safari 的 GestureEvent（觸控板 pinch）：
//   · { type: 'pinch', phase: 'start' | 'move' | 'end', points: [{ clientX, clientY }, { clientX, clientY }] }（end 是 []）
//   · { type: 'gesture', phase: 'start' | 'change' | 'end', scale, clientX, clientY }（scale 相對手勢開始時）
// - pin-pos（frame → parent）：作用中（active）的釘選圓點在 frame 捲動 / 版面變動後的位置
//   { id, clientX, clientY, hidden }，parent 讓留言編輯框跟著圓點走。
// - pins 每一項、highlight、scroll-to 都可以帶 selector（加上 pins 的 rect / dx / dy）：
//   頁面用內層容器捲動時，bridge 用 selector 找到元素定位（對不到唯一元素就退回 x / y）。

export const BRIDGE_PROTOCOL = 1;
/** window.codd.submit(data) 的上限：序列化後 256 KiB（bridge 端也會擋，這裡再擋一次） */
export const MAX_SUBMIT_BYTES = 256 * 1024;
export const MAX_PINS = 400;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COORD_LIMIT = 1e7;
const MAX_SELECTOR = 300;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCoord = (v) => isNum(v) && Math.abs(v) <= COORD_LIMIT;

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function byteLength(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length * 3; // 保守估計
}

function sanitizeRect(r) {
  if (!isPlainObject(r)) return null;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every(isCoord)) return null;
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/** selector：非空字串、不超過 MAX_SELECTOR 字才送（frame 那邊也只認這個長度內的） */
function sanitizeSelector(v) {
  return typeof v === 'string' && v && v.length <= MAX_SELECTOR ? v : null;
}

/** pick 的 target（§4）：字串截斷、陣列限長；格式不對就回 null（留言仍可以建，只是沒有元素資訊） */
export function sanitizeTarget(t) {
  if (!isPlainObject(t)) return null;
  const classes = Array.isArray(t.classes)
    ? t.classes.filter((c) => typeof c === 'string' && c).slice(0, 8).map((c) => c.slice(0, 60))
    : [];
  return {
    tag: str(t.tag, 40).toLowerCase(),
    id: typeof t.id === 'string' && t.id ? t.id.slice(0, 120) : null,
    classes,
    text: str(t.text, 200),
    selector: str(t.selector, 300),
    rect: sanitizeRect(t.rect),
  };
}

/**
 * 送進 frame 的 pins：只留 { id, n, x, y, active }，壞的丟掉。
 * 有 selector 時另外帶 selector 與 rect（或 dx / dy）：bridge 用它把圓點釘在元素上（內層容器捲動的頁面）
 */
export function sanitizePins(pins) {
  if (!Array.isArray(pins)) return [];
  const out = [];
  for (const p of pins) {
    if (out.length >= MAX_PINS) break;
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id)) continue;
    if (!isCoord(p.x) || !isCoord(p.y)) continue;
    const pin = {
      id: p.id,
      n: Number.isInteger(p.n) && p.n > 0 ? p.n : out.length + 1,
      x: p.x,
      y: p.y,
      active: !!p.active,
    };
    const selector = sanitizeSelector(p.selector);
    if (selector) {
      const rect = sanitizeRect(p.rect);
      if (isCoord(p.dx) && isCoord(p.dy)) Object.assign(pin, { selector, dx: p.dx, dy: p.dy });
      else if (rect) Object.assign(pin, { selector, rect });
    }
    out.push(pin);
  }
  return out;
}

/** submit-data：深拷貝成純 JSON 並檢查大小；不合格回 undefined */
function sanitizeSubmitData(data) {
  let json;
  try {
    json = JSON.stringify(data === undefined ? null : data);
  } catch {
    return undefined;
  }
  if (typeof json !== 'string') return undefined;
  if (byteLength(json) > MAX_SUBMIT_BYTES) {
    console.warn(`[artifact] window.codd.submit() 的資料超過 ${MAX_SUBMIT_BYTES / 1024} KiB，已忽略`);
    return undefined;
  }
  return JSON.parse(json);
}

/**
 * 掛上一個 artifact iframe。
 * @param {HTMLIFrameElement} iframe
 * @param {{ frameId?: string, onReady?: Function, onPick?: Function, onPinClick?: Function,
 *           onSubmitData?: Function, onPickCancel?: Function, onWheel?: Function, onPinch?: Function,
 *           onGesture?: Function, onPinPos?: Function, forwardZoom?: boolean }} handlers
 * @returns {{ setPickMode(on: boolean): void, setPins(pins: any[]): void, scrollTo(x: number, y: number, selector?: string): void,
 *             highlight(rect: object|null): void, setForwardZoom(on: boolean): void, detach(): void, isReady(): boolean }}
 */
export function attachFrame(iframe, handlers = {}) {
  const {
    frameId, onReady, onPick, onPinClick, onSubmitData, onPickCancel, onWheel, onPinch, onGesture, onPinPos,
    forwardZoom = false,
  } = handlers;
  // 監聽 iframe 所在的那個 window（一般就是 window；測試時可以塞假的 ownerDocument.defaultView）
  const host = iframe?.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);

  let detached = false;
  let ready = false;
  let pickMode = false;
  let pins = [];
  let highlightRect = null;
  let highlightSelector = null;
  let zoomForward = !!forwardZoom;
  // ready 之前呼叫的 scrollTo（frame 還在 lazy 載入）：等 ready 再送一次
  let pendingScroll = null;
  // 上次送出的內容（序列化），同樣的東西不重送；ready 時強制重送
  const lastSent = { pickMode: null, pins: null, highlight: null, zoom: null };

  function post(msg) {
    if (detached) return false;
    const win = iframe?.contentWindow;
    if (!win || typeof win.postMessage !== 'function') return false;
    try {
      win.postMessage({ codd: BRIDGE_PROTOCOL, ...msg }, '*');
      return true;
    } catch {
      return false;
    }
  }

  function sendPickMode(force) {
    const key = pickMode ? '1' : '0';
    if (!force && lastSent.pickMode === key) return;
    if (post({ type: 'pick-mode', on: pickMode })) lastSent.pickMode = key;
  }

  function sendPins(force) {
    const key = JSON.stringify(pins);
    if (!force && lastSent.pins === key) return;
    if (post({ type: 'pins', pins })) lastSent.pins = key;
  }

  function sendZoomForward(force) {
    const key = zoomForward ? '1' : '0';
    if (!force && lastSent.zoom === key) return;
    if (post({ type: 'zoom-forward', on: zoomForward })) lastSent.zoom = key;
  }

  function sendHighlight(force) {
    const key = JSON.stringify([highlightRect, highlightSelector]);
    if (!force && lastSent.highlight === key) return;
    const msg = { type: 'highlight', rect: highlightRect };
    if (highlightRect && highlightSelector) msg.selector = highlightSelector;
    if (post(msg)) lastSent.highlight = key;
  }

  function call(fn, payload) {
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch (err) {
      console.error('[artifact] frame handler 發生錯誤', err);
    }
  }

  function onMessage(event) {
    if (detached || !iframe) return;
    const win = iframe.contentWindow;
    if (!win || event.source !== win) return;
    const msg = event.data;
    if (!isPlainObject(msg) || msg.codd !== BRIDGE_PROTOCOL || typeof msg.type !== 'string') return;
    // frameId 有給就一定要對得上（同一個 iframe 換了 src 但舊頁面的訊息還在路上時，以 frameId 區分）
    if (frameId != null && msg.frameId !== undefined && msg.frameId !== frameId) return;
    const fid = frameId ?? (typeof msg.frameId === 'string' ? msg.frameId : null);

    switch (msg.type) {
      case 'ready': {
        ready = true;
        // 新文件：先前送過的狀態都不算數，全部重送
        sendPickMode(true);
        sendPins(true);
        if (zoomForward) sendZoomForward(true);
        else lastSent.zoom = null;
        if (highlightRect) sendHighlight(true);
        else lastSent.highlight = null;
        if (pendingScroll) {
          post({ type: 'scroll-to', ...pendingScroll });
          pendingScroll = null;
        }
        call(onReady, {
          frameId: fid,
          docWidth: isCoord(msg.docWidth) && msg.docWidth >= 0 ? msg.docWidth : null,
          docHeight: isCoord(msg.docHeight) && msg.docHeight >= 0 ? msg.docHeight : null,
        });
        break;
      }
      case 'pick': {
        // 已經關掉選取模式時，還在路上的 pick 不算
        if (!pickMode) return;
        if (![msg.x, msg.y, msg.clientX, msg.clientY].every(isCoord)) return;
        call(onPick, {
          frameId: fid,
          x: msg.x,
          y: msg.y,
          clientX: msg.clientX,
          clientY: msg.clientY,
          target: sanitizeTarget(msg.target),
        });
        break;
      }
      case 'pin-click': {
        if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return;
        if (!isCoord(msg.clientX) || !isCoord(msg.clientY)) return;
        call(onPinClick, { frameId: fid, id: msg.id, clientX: msg.clientX, clientY: msg.clientY });
        break;
      }
      case 'submit-data': {
        if (!('data' in msg)) return;
        const data = sanitizeSubmitData(msg.data);
        if (data === undefined) return;
        call(onSubmitData, { frameId: fid, data });
        break;
      }
      case 'pick-cancel': {
        call(onPickCancel, { frameId: fid });
        break;
      }
      case 'pin-pos': {
        if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return;
        if (!isCoord(msg.clientX) || !isCoord(msg.clientY)) return;
        call(onPinPos, { frameId: fid, id: msg.id, clientX: msg.clientX, clientY: msg.clientY, hidden: msg.hidden === true });
        break;
      }
      case 'pinch': {
        // 兩指觸控 pinch（只在 zoom-forward 開著時才算；frame 自己亂送的不理）
        if (!zoomForward || !['start', 'move', 'end'].includes(msg.phase)) return;
        const pts = Array.isArray(msg.points) ? msg.points.slice(0, 2) : [];
        const points = pts.filter((q) => isPlainObject(q) && isCoord(q.clientX) && isCoord(q.clientY))
          .map((q) => ({ clientX: q.clientX, clientY: q.clientY }));
        if (msg.phase !== 'end' && points.length < 2) return;
        call(onPinch, { frameId: fid, phase: msg.phase, points: msg.phase === 'end' ? [] : points });
        break;
      }
      case 'gesture': {
        // Safari 的 GestureEvent（macOS 觸控板 pinch）
        if (!zoomForward || !['start', 'change', 'end'].includes(msg.phase)) return;
        if (!isNum(msg.scale) || msg.scale < 0.05 || msg.scale > 20) return;
        if (!isCoord(msg.clientX) || !isCoord(msg.clientY)) return;
        call(onGesture, { frameId: fid, phase: msg.phase, scale: msg.scale, clientX: msg.clientX, clientY: msg.clientY });
        break;
      }
      case 'wheel': {
        // 選用擴充：只接受 Ctrl/⌘ + 滾輪（縮放）；一般滾輪留在 frame 裡捲動內容
        if (msg.ctrlKey !== true) return;
        if (![msg.clientX, msg.clientY].every(isCoord)) return;
        if (![msg.deltaX ?? 0, msg.deltaY].every((v) => isNum(v) && Math.abs(v) <= 10000)) return;
        const deltaMode = [0, 1, 2].includes(msg.deltaMode) ? msg.deltaMode : 0;
        call(onWheel, {
          frameId: fid,
          clientX: msg.clientX,
          clientY: msg.clientY,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY,
          deltaMode,
          ctrlKey: true,
        });
        break;
      }
      default:
        // 不認得的 type：忽略
        break;
    }
  }

  host?.addEventListener?.('message', onMessage);

  return {
    setPickMode(on) {
      pickMode = !!on;
      sendPickMode(false);
    },
    setPins(next) {
      pins = sanitizePins(next);
      sendPins(false);
    },
    /** selector（選用）：內層容器捲動的頁面，bridge 改用 scrollIntoView 捲到那個元素 */
    scrollTo(x, y, selector) {
      if (!isCoord(x) || !isCoord(y)) return;
      const sel = sanitizeSelector(selector);
      const msg = sel ? { x, y, selector: sel } : { x, y };
      pendingScroll = ready ? null : msg;
      post({ type: 'scroll-to', ...msg });
    },
    /** rect 可以帶 selector 欄位（留言的 target.selector）：bridge 用它跟著元素畫外框 */
    highlight(rect) {
      highlightRect = rect ? sanitizeRect(rect) : null;
      highlightSelector = highlightRect ? sanitizeSelector(rect?.selector) : null;
      sendHighlight(false);
    },
    setForwardZoom(on) {
      zoomForward = !!on;
      sendZoomForward(false);
    },
    isReady() {
      return ready;
    },
    detach() {
      if (detached) return;
      detached = true;
      host?.removeEventListener?.('message', onMessage);
    },
  };
}
