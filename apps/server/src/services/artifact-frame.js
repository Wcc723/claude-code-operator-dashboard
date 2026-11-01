// artifact frame 文件：把 bridge script 插進使用者（Claude）寫的 HTML，交給 sandbox iframe 顯示。
// - frame 路由一律送 FRAME_CSP（含 sandbox 指令），所以就算有人直接開這個網址，頁面也是在 sandbox 裡跑。
// - bridge 跟 parent（CODD SPA）用 postMessage 溝通（協定見 ARTIFACT 規格 §6）：
//   frame → parent：ready / pick / pin-click / submit-data / pick-cancel（另有選用的 wheel / pinch / gesture，見下）、
//   pin-pos（作用中的釘選圓點捲動 / 版面變動後的位置 { id, clientX, clientY, hidden }，parent 讓留言編輯框跟著它）
//   parent → frame：pick-mode / pins / scroll-to / highlight / zoom-forward
// - zoom-forward（on: true，canvas 才送）：frame 裡的縮放手勢不讓瀏覽器縮放整頁，改轉給畫布縮放：
//   · Ctrl + 滾輪（觸控板 pinch）→ { type: 'wheel', clientX, clientY, deltaX, deltaY, deltaMode, ctrlKey: true }
//   · 兩指觸控 pinch → { type: 'pinch', phase: 'start' | 'move' | 'end', points: [{ clientX, clientY }, { clientX, clientY }] }
//     （end 的 points 是空陣列；pinch 期間第二指以上的 touchmove 會 preventDefault）
//   · Safari 的 GestureEvent（macOS 觸控板 pinch）→ { type: 'gesture', phase: 'start' | 'change' | 'end', scale, clientX, clientY }
//     （scale 是相對手勢開始時的倍率；iOS 已經用 pinch 轉送的就不再送 gesture）
//   座標都是 frame 的 viewport（client）座標。沒開時不掛這些 listener（非 passive 的 listener 會拖慢捲動）
// - 釘選圓點 / highlight / scroll-to 可以帶 selector：頁面用內層容器捲動時（html,body{overflow:hidden} + main 捲動），
//   文件座標會跟內容脫鉤，有 selector 且剛好對到一個元素時改用該元素目前的位置：
//   · pins 的每一項可加 selector，加上 dx / dy（點擊位置相對元素左上角）或 rect（留言的 target.rect，dx/dy 由 x - rect.x 算）
//   · highlight 可加 selector；scroll-to 可加 selector（改用 scrollIntoView，內層容器也會捲）
//   圓點會在任何元素捲動、視窗大小改變時重新定位；元素被捲到所在容器外面時圓點先藏起來
// - bridge 不依賴任何外部資源；畫在頁面上的東西（滑過外框、釘選圓點、highlight）都放在自己的 shadow root。

export const FRAME_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const HEAD_META = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';

// 這個函式不在 server 執行：toString() 後原樣塞進 frame 文件的 <script>，在瀏覽器（iframe 內）執行。
// 只能用瀏覽器內建 API，不能引用外層變數；字串裡不能出現「</script」或「<!--」（會打斷外層 script 標籤）。
function coddBridge(FRAME_ID) {
  'use strict';
  var w = window;
  var d = document;
  var parentWin = w.parent;
  var MAX_DATA_BYTES = 256 * 1024;
  var MAX_PINS = 500;
  var TAP_SLOP = 10;
  var ACCENT = '#ffb84a';

  var pickOn = false;
  var host = null;
  var root = null;
  var hoverBox = null;
  var hoverLabel = null;
  var hiBox = null;
  var pinWrap = null;
  var hoverEl = null;
  var hoverRaf = 0;
  var cursorSheet = null;
  var touch = null;
  var lastTouchPick = 0;
  var zoomFwd = false;
  var WHEEL_MAX = 10000;
  var pinch = false;
  var gestureOn = false;
  var pinItems = [];
  var hiItem = null;
  var layoutRaf = 0;
  var activeRaf = 0;
  var MAX_SELECTOR = 300;

  function post(msg) {
    msg.codd = 1;
    msg.frameId = FRAME_ID;
    try { parentWin.postMessage(msg, '*'); } catch (e) { /* parent 不在了 */ }
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function scrollXY() {
    return { x: w.scrollX || w.pageXOffset || 0, y: w.scrollY || w.pageYOffset || 0 };
  }

  // ---------- overlay（shadow root）----------

  var OVERLAY_CSS = [
    ':host{all:initial}',
    '.layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;',
    'font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.box{position:absolute;box-sizing:border-box;pointer-events:none;display:none}',
    '.hover{border:2px solid ' + ACCENT + ';background:rgba(255,184,74,.12);border-radius:2px}',
    '.hover .lbl{position:absolute;left:-2px;bottom:100%;margin-bottom:2px;padding:1px 6px;background:' + ACCENT + ';',
    'color:#141414;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;border-radius:2px}',
    '.hover.inside .lbl{bottom:auto;top:0;margin:0}',
    '.hi{border:2px dashed #4ea1ff;background:rgba(78,161,255,.12);border-radius:2px}',
    '.pins{position:absolute;left:0;top:0;width:0;height:0}',
    '.pin{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;box-sizing:border-box;border-radius:50%;',
    'background:' + ACCENT + ';color:#141414;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);',
    'display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;cursor:pointer;',
    'pointer-events:auto;user-select:none;-webkit-user-select:none;touch-action:manipulation;transition:transform .12s ease}',
    '.pin:hover{transform:scale(1.15)}',
    '.pin.active{transform:scale(1.35);background:#ffd089;z-index:1;',
    'box-shadow:0 0 0 4px rgba(255,184,74,.45),0 2px 6px rgba(0,0,0,.5)}',
  ].join('');

  function ensureHost() {
    if (!host) {
      host = d.createElement('codd-bridge-overlay');
      host.setAttribute('style', [
        'all:initial', 'display:block', 'position:absolute', 'left:0', 'top:0', 'width:0', 'height:0',
        'overflow:visible', 'margin:0', 'padding:0', 'border:0', 'z-index:2147483647', 'pointer-events:none',
      ].map(function (x) { return x + ' !important'; }).join(';'));
      root = host.attachShadow({ mode: 'open' });
      var style = d.createElement('style');
      style.textContent = OVERLAY_CSS;
      var layer = d.createElement('div');
      layer.className = 'layer';
      hiBox = d.createElement('div');
      hiBox.className = 'box hi';
      hoverBox = d.createElement('div');
      hoverBox.className = 'box hover';
      hoverLabel = d.createElement('span');
      hoverLabel.className = 'lbl';
      hoverBox.appendChild(hoverLabel);
      pinWrap = d.createElement('div');
      pinWrap.className = 'pins';
      layer.appendChild(hiBox);
      layer.appendChild(hoverBox);
      layer.appendChild(pinWrap);
      root.appendChild(style);
      root.appendChild(layer);
    }
    // 頁面可能整個換掉 body / documentElement 的內容：每次要畫之前確認還掛著
    if (!host.isConnected) (d.documentElement || d).appendChild(host);
  }

  function placeBox(box, x, y, width, height) {
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = Math.max(0, width) + 'px';
    box.style.height = Math.max(0, height) + 'px';
    box.style.display = 'block';
  }

  function isOurs(e) {
    if (!host) return false;
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.indexOf(host) >= 0 || e.target === host;
  }

  function pinOf(e) {
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-pin')) return n;
    }
    return null;
  }

  // ---------- 被點到的元素資訊 ----------

  function classesOf(el) {
    var out = [];
    var cl = el.classList;
    if (cl) for (var i = 0; i < cl.length; i++) out.push(String(cl[i]));
    return out;
  }

  function esc(s) {
    if (w.CSS && typeof w.CSS.escape === 'function') return w.CSS.escape(s);
    return String(s).replace(/[^A-Za-z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function segment(el) {
    var tag = el.localName || 'node';
    if (el.id) return { s: tag + '#' + esc(el.id), anchor: true };
    var s = tag;
    var cls = classesOf(el).slice(0, 2);
    for (var i = 0; i < cls.length; i++) s += '.' + esc(cls[i]);
    var p = el.parentElement;
    if (p) {
      var same = 0;
      var idx = 0;
      for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === el.localName) {
          same++;
          if (c === el) idx = same;
        }
      }
      if (same > 1) s += ':nth-of-type(' + idx + ')';
    }
    return { s: s, anchor: false };
  }

  // 最多 5 層的 tag#id.class:nth-of-type() 路徑；遇到有 id 的祖先就停
  function selectorOf(el) {
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1 && parts.length < 5; cur = cur.parentElement) {
      var tag = cur.localName;
      if ((tag === 'body' || tag === 'html') && cur !== el) break;
      var seg = segment(cur);
      parts.unshift(seg.s);
      if (seg.anchor) break;
    }
    return parts.join(' > ').slice(0, 300);
  }

  function textOf(el) {
    var tag = el.localName;
    var t = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // 不帶使用者填的值（可能是密碼），只拿標示用的屬性
      var type = String(el.getAttribute('type') || '').toLowerCase();
      t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')
        || (tag === 'input' && /^(button|submit|reset)$/.test(type) ? el.getAttribute('value') : '')
        || el.getAttribute('name') || '';
    } else if (tag === 'img') {
      t = el.getAttribute('alt') || el.getAttribute('title') || '';
    } else {
      var raw = el.textContent || '';
      // innerText 會觸發排版：只在內容不大時用（比較接近畫面上看到的字）
      if (raw.length < 4000 && typeof el.innerText === 'string') raw = el.innerText;
      t = raw;
      if (!String(t).trim() && el.getAttribute) t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    }
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var s = scrollXY();
    return {
      tag: String(el.localName || el.nodeName || '').toLowerCase().slice(0, 40),
      id: el.id ? String(el.id).slice(0, 100) : null,
      classes: classesOf(el).slice(0, 8).map(function (c) { return c.slice(0, 60); }),
      text: textOf(el),
      selector: selectorOf(el),
      rect: {
        x: Math.round(r.left + s.x),
        y: Math.round(r.top + s.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  }

  function elementAt(clientX, clientY, fallback) {
    var el = fallback && fallback.nodeType === 1 ? fallback : null;
    if (!el && typeof d.elementFromPoint === 'function') el = d.elementFromPoint(clientX, clientY);
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || el === host) return null;
    return el;
  }

  function sendPick(el, clientX, clientY) {
    if (!el) return;
    var s = scrollXY();
    post({
      type: 'pick',
      x: Math.round(clientX + s.x),
      y: Math.round(clientY + s.y),
      clientX: Math.round(clientX),
      clientY: Math.round(clientY),
      target: describe(el),
    });
  }

  // ---------- 選取模式 ----------

  function setCursor(on) {
    try {
      if (!cursorSheet) {
        cursorSheet = new CSSStyleSheet();
        cursorSheet.replaceSync('*,*::before,*::after{cursor:crosshair !important}');
      }
      var list = Array.prototype.slice.call(d.adoptedStyleSheets || []).filter(function (x) { return x !== cursorSheet; });
      if (on) list.push(cursorSheet);
      d.adoptedStyleSheets = list;
    } catch (e) {
      // 舊瀏覽器沒有 constructable stylesheet：退而求其次只設根元素
      if (d.documentElement) d.documentElement.style.cursor = on ? 'crosshair' : '';
    }
  }

  function labelFor(el) {
    var s = el.localName || '';
    if (el.id) s += '#' + el.id;
    else {
      var cls = classesOf(el).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
    }
    return s;
  }

  function drawHover() {
    hoverRaf = 0;
    if (!pickOn || !hoverEl || !hoverEl.isConnected) {
      if (hoverBox) hoverBox.style.display = 'none';
      return;
    }
    ensureHost();
    var r = hoverEl.getBoundingClientRect();
    var s = scrollXY();
    placeBox(hoverBox, r.left + s.x, r.top + s.y, r.width, r.height);
    hoverLabel.textContent = labelFor(hoverEl);
    // 元素貼著視窗頂端時，標籤改畫在框內，免得被切掉
    if (r.top < 18) hoverBox.classList.add('inside');
    else hoverBox.classList.remove('inside');
  }

  function setHover(el) {
    hoverEl = el;
    if (hoverRaf) return;
    hoverRaf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame(drawHover) : setTimeout(drawHover, 16);
  }

  function setPick(on) {
    on = !!on;
    if (on === pickOn) return;
    pickOn = on;
    touch = null;
    setCursor(on);
    if (!on) setHover(null);
  }

  // capture 階段在 window 上攔：bridge 是頁面第一支 script，比頁面自己的 handler 都早
  function onPointerish(e) {
    if (isOurs(e)) {
      // 自己的釘選圓點：不讓頁面的 handler 看到；點擊送 pin-click
      e.stopImmediatePropagation();
      if (e.type === 'click') {
        var pin = pinOf(e);
        if (pin) {
          e.preventDefault();
          post({ type: 'pin-click', id: pin.getAttribute('data-pin'), clientX: Math.round(e.clientX), clientY: Math.round(e.clientY) });
        }
      }
      return;
    }
    if (!pickOn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      // 觸控已經在 touchend 送過了，瀏覽器若仍補發 click 就略過
      if (Date.now() - lastTouchPick < 800) return;
      var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      sendPick(elementAt(e.clientX, e.clientY, path[0] || e.target), e.clientX, e.clientY);
    }
  }

  function onTouch(e) {
    // 兩指 pinch（zoom-forward 時）轉給畫布，不當成點選；不 stopImmediatePropagation，後面的 touchmove 攔截才跑得到
    if (trackPinch(e)) return;
    if (isOurs(e)) {
      e.stopImmediatePropagation();
      return;
    }
    if (!pickOn) return;
    // 不 preventDefault touchstart / touchmove：選取模式下仍然可以捲動
    e.stopImmediatePropagation();
    var t = (e.changedTouches && e.changedTouches[0]) || null;
    if (e.type === 'touchstart') {
      if (!t || (e.touches && e.touches.length > 1)) { touch = null; return; }
      var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      touch = { x: t.clientX, y: t.clientY, el: path[0] || e.target, moved: false };
      setHover(elementAt(t.clientX, t.clientY, touch.el));
    } else if (e.type === 'touchmove') {
      if (touch && t && (Math.abs(t.clientX - touch.x) > TAP_SLOP || Math.abs(t.clientY - touch.y) > TAP_SLOP)) {
        touch.moved = true;
        setHover(null);
      }
    } else if (e.type === 'touchend') {
      var tap = touch && !touch.moved && t;
      var el = touch && touch.el;
      touch = null;
      if (!tap) return;
      // 是點一下（不是捲動）：取消瀏覽器後續補發的 mouse / click，直接送 pick
      if (e.cancelable) e.preventDefault();
      lastTouchPick = Date.now();
      sendPick(elementAt(t.clientX, t.clientY, el), t.clientX, t.clientY);
    } else {
      touch = null;
      setHover(null);
    }
  }

  function onMove(e) {
    if (!pickOn || e.pointerType === 'touch') return;
    if (isOurs(e)) { setHover(null); return; }
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    setHover(elementAt(e.clientX, e.clientY, path[0] || e.target));
  }

  function onKey(e) {
    if (!pickOn || (e.key !== 'Escape' && e.key !== 'Esc')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ type: 'pick-cancel' });
  }

  var BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  for (var i = 0; i < BLOCKED.length; i++) w.addEventListener(BLOCKED[i], onPointerish, { capture: true, passive: false });
  w.addEventListener('touchstart', onTouch, { capture: true, passive: true });
  w.addEventListener('touchmove', onTouch, { capture: true, passive: true });
  w.addEventListener('touchend', onTouch, { capture: true, passive: false });
  w.addEventListener('touchcancel', onTouch, { capture: true, passive: true });
  w.addEventListener('pointermove', onMove, { capture: true, passive: true });
  w.addEventListener('keydown', onKey, true);
  // capture：內層容器的捲動也收得到（scroll 不會冒泡）
  w.addEventListener('scroll', function () {
    if (pickOn && hoverEl) setHover(hoverEl);
    scheduleLayout();
    scheduleActivePin();
  }, { capture: true, passive: true });
  w.addEventListener('resize', function () { scheduleLayout(); scheduleActivePin(); }, { passive: true });
  w.addEventListener('load', function () { scheduleLayout(); scheduleActivePin(); });
  if (d.documentElement) d.documentElement.addEventListener('mouseleave', function () { setHover(null); });

  // ---------- Ctrl + 滾輪轉給畫布（zoom-forward）----------

  function clampDelta(v) {
    v = num(v) || 0;
    return Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, v));
  }

  function onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    post({
      type: 'wheel', clientX: Math.round(e.clientX), clientY: Math.round(e.clientY),
      deltaX: clampDelta(e.deltaX), deltaY: clampDelta(e.deltaY), deltaMode: e.deltaMode, ctrlKey: true,
    });
  }

  // ---------- 兩指 pinch / Safari gesture 轉給畫布（zoom-forward）----------

  function touchPoints(e) {
    var out = [];
    var list = e.touches;
    for (var i = 0; list && i < list.length && out.length < 2; i++) {
      out.push({ clientX: Math.round(list[i].clientX), clientY: Math.round(list[i].clientY) });
    }
    return out;
  }

  // true = 這個觸控事件屬於兩指 pinch（已轉送），呼叫端不要再當成點選處理
  function trackPinch(e) {
    if (!zoomFwd) return false;
    var n = e.touches ? e.touches.length : 0;
    if (e.type === 'touchstart') {
      if (n < 2) return false;
      if (!pinch) {
        pinch = true;
        touch = null;
        setHover(null);
        post({ type: 'pinch', phase: 'start', points: touchPoints(e) });
      }
      return true;
    }
    if (!pinch) return false;
    if (e.type === 'touchmove') {
      if (n >= 2) post({ type: 'pinch', phase: 'move', points: touchPoints(e) });
      return true;
    }
    // touchend / touchcancel：剩不到兩指就結束（剩下那一指不會變成點選：touch 已清掉）
    if (n < 2) endPinch();
    return true;
  }

  function endPinch() {
    if (!pinch) return;
    pinch = false;
    post({ type: 'pinch', phase: 'end', points: [] });
  }

  // 只有兩指以上才擋（瀏覽器自己的縮放 / 捲動）；一指照常捲動 frame 內容
  function blockPinch(e) {
    if (e.touches && e.touches.length >= 2 && e.cancelable) e.preventDefault();
  }

  function onGesture(e) {
    if (e.cancelable) e.preventDefault();
    if (e.type === 'gesturestart') {
      if (pinch) return; // iOS：touch 已經在轉送了
      gestureOn = true;
    } else if (!gestureOn) {
      return;
    }
    var sc = num(e.scale);
    post({
      type: 'gesture',
      phase: e.type === 'gesturestart' ? 'start' : (e.type === 'gestureend' ? 'end' : 'change'),
      scale: sc === null ? 1 : Math.max(0.05, Math.min(20, sc)),
      clientX: Math.round(num(e.clientX) || 0),
      clientY: Math.round(num(e.clientY) || 0),
    });
    if (e.type === 'gestureend') gestureOn = false;
  }

  var GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];

  function setZoomForward(on) {
    on = !!on;
    if (on === zoomFwd) return;
    zoomFwd = on;
    var i;
    if (on) {
      w.addEventListener('wheel', onWheel, { capture: true, passive: false });
      w.addEventListener('touchmove', blockPinch, { capture: true, passive: false });
      for (i = 0; i < GESTURES.length; i++) w.addEventListener(GESTURES[i], onGesture, { capture: true, passive: false });
    } else {
      w.removeEventListener('wheel', onWheel, { capture: true });
      w.removeEventListener('touchmove', blockPinch, { capture: true });
      for (i = 0; i < GESTURES.length; i++) w.removeEventListener(GESTURES[i], onGesture, { capture: true });
      endPinch();
      gestureOn = false;
    }
  }

  // ---------- parent → frame ----------

  // ---------- selector 定位（內層容器捲動的頁面）----------

  // 剛好對到一個元素才用（selectorOf 產生的路徑不保證唯一）
  function resolveSel(sel) {
    if (typeof sel !== 'string' || !sel || sel.length > MAX_SELECTOR) return null;
    var list;
    try { list = d.querySelectorAll(sel); } catch (e) { return null; }
    if (!list || list.length !== 1) return null;
    var el = list[0];
    return el === host ? null : el;
  }

  // 會裁切內容的祖先（捲動容器等）：元素被捲到它外面時，圓點不畫
  function clipAncestors(el) {
    var out = [];
    for (var p = el.parentElement, i = 0; p && i < 40; p = p.parentElement, i++) {
      if (p === d.body || p === d.documentElement) break;
      var cs = w.getComputedStyle ? w.getComputedStyle(p) : null;
      if (cs && /(auto|scroll|hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY)) out.push(p);
    }
    return out;
  }

  function anchorEl(item) {
    if (!item.sel) return null;
    if (!item.el || !item.el.isConnected) {
      item.el = resolveSel(item.sel);
      item.clips = item.el ? clipAncestors(item.el) : [];
    }
    var el = item.el;
    return el && el.getClientRects().length ? el : null;
  }

  function clippedOut(item, cx, cy) {
    for (var i = 0; i < item.clips.length; i++) {
      var r = item.clips[i].getBoundingClientRect();
      if (cx < r.left - 1 || cx > r.right + 1 || cy < r.top - 1 || cy > r.bottom + 1) return true;
    }
    return false;
  }

  // 圓點位置（文件座標）：selector 對得到就跟著元素走，否則用原本的 x / y
  function pinPoint(item) {
    var el = anchorEl(item);
    if (el) {
      var r = el.getBoundingClientRect();
      var cx = r.left + Math.max(0, Math.min(r.width, item.dx));
      var cy = r.top + Math.max(0, Math.min(r.height, item.dy));
      var s = scrollXY();
      return { x: cx + s.x, y: cy + s.y, hidden: clippedOut(item, cx, cy) };
    }
    return { x: item.x, y: item.y, hidden: false };
  }

  function placePin(item) {
    var pt = pinPoint(item);
    item.dot.style.left = pt.x + 'px';
    item.dot.style.top = pt.y + 'px';
    item.dot.style.display = pt.hidden ? 'none' : '';
  }

  function placeHighlight() {
    if (!hiItem || !hiBox) return;
    var el = anchorEl(hiItem);
    if (el) {
      var r = el.getBoundingClientRect();
      var s = scrollXY();
      placeBox(hiBox, r.left + s.x, r.top + s.y, r.width, r.height);
      return;
    }
    if (hiItem.rect) placeBox(hiBox, hiItem.rect.x, hiItem.rect.y, hiItem.rect.width, hiItem.rect.height);
  }

  function layoutAnchored() {
    layoutRaf = 0;
    for (var i = 0; i < pinItems.length; i++) if (pinItems[i].sel) placePin(pinItems[i]);
    if (hiItem && hiItem.sel) placeHighlight();
  }

  function hasAnchored() {
    if (hiItem && hiItem.sel) return true;
    for (var i = 0; i < pinItems.length; i++) if (pinItems[i].sel) return true;
    return false;
  }

  function scheduleLayout() {
    if (layoutRaf || !hasAnchored()) return;
    layoutRaf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame(layoutAnchored) : setTimeout(layoutAnchored, 16);
  }

  function selOf(v) {
    return typeof v === 'string' && v && v.length <= MAX_SELECTOR ? v : null;
  }

  function setPins(list) {
    if (!Array.isArray(list)) return;
    if (!list.length && !host) return;
    ensureHost();
    pinWrap.textContent = '';
    pinItems = [];
    var n = Math.min(list.length, MAX_PINS);
    for (var i = 0; i < n; i++) {
      var p = list[i];
      if (!p || typeof p !== 'object') continue;
      var x = num(p.x);
      var y = num(p.y);
      if (x === null || y === null || typeof p.id !== 'string' || !p.id) continue;
      var dot = d.createElement('div');
      dot.className = p.active ? 'pin active' : 'pin';
      dot.setAttribute('data-pin', p.id.slice(0, 64));
      dot.setAttribute('role', 'button');
      dot.textContent = String(p.n === undefined || p.n === null ? i + 1 : p.n).slice(0, 4);
      // 點擊位置相對元素左上角：給 dx / dy，或從 rect（留言的 target.rect，跟 x / y 同一個座標系）算
      var rect = p.rect && typeof p.rect === 'object' ? p.rect : null;
      var dx = num(p.dx);
      var dy = num(p.dy);
      if (dx === null && rect && num(rect.x) !== null) dx = x - rect.x;
      if (dy === null && rect && num(rect.y) !== null) dy = y - rect.y;
      var sel = dx !== null && dy !== null ? selOf(p.selector) : null;
      var item = { dot: dot, id: p.id.slice(0, 64), active: !!p.active, x: x, y: y, sel: sel, dx: dx || 0, dy: dy || 0, el: null, clips: [] };
      pinItems.push(item);
      placePin(item);
      pinWrap.appendChild(dot);
    }
  }

  // 作用中（parent 正在編輯那則留言）的圓點：捲動 / 版面變動後回報它在 frame 視窗裡的位置（每個畫面最多一次）
  function activePin() {
    for (var i = 0; i < pinItems.length; i++) if (pinItems[i].active) return pinItems[i];
    return null;
  }

  function reportActivePin() {
    activeRaf = 0;
    var item = activePin();
    if (!item) return;
    var pt = pinPoint(item);
    var s = scrollXY();
    post({ type: 'pin-pos', id: item.id, clientX: Math.round(pt.x - s.x), clientY: Math.round(pt.y - s.y), hidden: !!pt.hidden });
  }

  function scheduleActivePin() {
    if (activeRaf || !activePin()) return;
    activeRaf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame(reportActivePin) : setTimeout(reportActivePin, 16);
  }

  function setHighlight(rect, selector) {
    if (!rect || typeof rect !== 'object') {
      hiItem = null;
      if (hiBox) hiBox.style.display = 'none';
      return;
    }
    var x = num(rect.x);
    var y = num(rect.y);
    var width = num(rect.width);
    var height = num(rect.height);
    if (x === null || y === null || width === null || height === null) return;
    ensureHost();
    hiItem = { rect: { x: x, y: y, width: width, height: height }, sel: selOf(selector), el: null, clips: [] };
    placeHighlight();
  }

  function scrollToPoint(x, y, selector) {
    var el = resolveSel(selOf(selector));
    if (el && el.getClientRects().length && typeof el.scrollIntoView === 'function') {
      // 內層捲動容器也會跟著捲
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
      return;
    }
    x = num(x);
    y = num(y);
    if (x === null || y === null) return;
    var left = Math.max(0, x - w.innerWidth / 2);
    var top = Math.max(0, y - w.innerHeight / 2);
    try { w.scrollTo({ left: left, top: top, behavior: 'smooth' }); } catch (e) { w.scrollTo(left, top); }
  }

  w.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.codd !== 1) return;
    // CODD 自己的訊息不讓頁面的 message handler 看到
    e.stopImmediatePropagation();
    if (m.type === 'pick-mode') setPick(m.on === true);
    else if (m.type === 'pins') setPins(m.pins);
    else if (m.type === 'scroll-to') scrollToPoint(m.x, m.y, m.selector);
    else if (m.type === 'highlight') setHighlight(m.rect, m.selector);
    else if (m.type === 'zoom-forward') setZoomForward(m.on === true);
  }, true);

  // ---------- window.codd ----------

  function byteLength(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  w.codd = {
    version: 1,
    // 把任意 JSON 資料交給 CODD（使用者按「提交」時一起送給 Claude）。成功送出回 true
    submit: function (data) {
      var json;
      try { json = JSON.stringify(data === undefined ? null : data); } catch (err) {
        console.warn('[codd] submit：資料無法轉成 JSON，沒有送出', err);
        return false;
      }
      if (json === undefined) json = 'null';
      if (byteLength(json) > MAX_DATA_BYTES) {
        console.warn('[codd] submit：資料超過 256 KiB，沒有送出');
        return false;
      }
      post({ type: 'submit-data', data: JSON.parse(json) });
      return true;
    },
  };

  // ---------- ready ----------

  function sendReady() {
    var de = d.documentElement;
    var b = d.body;
    post({
      type: 'ready',
      docWidth: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
      docHeight: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0),
    });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', sendReady, { once: true });
  else sendReady();
}

export const BRIDGE_SOURCE = coddBridge.toString();
if (/<\/script|<!--/i.test(BRIDGE_SOURCE)) {
  throw new Error('artifact-frame: bridge source must not contain "</script" or "<!--"');
}

function bridgeTag(frameId) {
  const id = JSON.stringify(String(frameId ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script>(${BRIDGE_SOURCE})(${id});</script>`;
}

// 標籤屬性值裡可能有 >（例如 data-x="a>b"），要跳過引號
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const RE = {
  ws: /\s*/y,
  comment: /<!--[\s\S]*?-->/y,
  doctype: new RegExp(`<!doctype\\b${ATTRS}>`, 'iy'),
  pi: /<\?[^>]*>/y,
  html: new RegExp(`<html(?=[\\s/>])${ATTRS}>`, 'iy'),
  head: new RegExp(`<head(?=[\\s/>])${ATTRS}>`, 'iy'),
};

function matchAt(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? m[0].length : 0;
}

// 只看文件開頭（空白、註解、doctype、<html>）找 <head>；正文裡的字串不會被誤認
function locate(src) {
  let i = 0;
  let doctypeEnd = -1;
  let htmlEnd = -1;
  for (let guard = 0; guard < 10000; guard++) {
    i += matchAt(RE.ws, src, i);
    let n;
    if ((n = matchAt(RE.comment, src, i))) { i += n; continue; }
    if (htmlEnd < 0 && (n = matchAt(RE.doctype, src, i))) { i += n; doctypeEnd = i; continue; }
    if (htmlEnd < 0 && doctypeEnd < 0 && (n = matchAt(RE.pi, src, i))) { i += n; continue; }
    if (htmlEnd < 0 && (n = matchAt(RE.html, src, i))) { i += n; htmlEnd = i; continue; }
    if ((n = matchAt(RE.head, src, i))) return { kind: 'head', at: i + n };
    break;
  }
  if (htmlEnd >= 0) return { kind: 'html', at: htmlEnd };
  if (doctypeEnd >= 0) return { kind: 'doctype', at: doctypeEnd };
  return { kind: 'fragment', at: 0 };
}

/**
 * 把 bridge script 插在 <head> 最前面。
 * - 有 <head>：插在 <head …> 後面
 * - 有 <html> 沒 <head>：插在 <html …> 後面（瀏覽器會自動補 head，script 落在 head 裡）
 * - 只有 doctype：接在 doctype 後面（同上）
 * - 片段：包成完整文件
 */
export function buildFrameDocument(html, { frameId } = {}) {
  const src = String(html ?? '').replace(/^\uFEFF/, '');
  const tag = bridgeTag(frameId);
  const loc = locate(src);
  if (loc.kind === 'head' || loc.kind === 'html') return src.slice(0, loc.at) + tag + src.slice(loc.at);
  if (loc.kind === 'doctype') return src.slice(0, loc.at) + HEAD_META + tag + src.slice(loc.at);
  return `<!doctype html><html><head>${HEAD_META}${tag}</head><body>${src}</body></html>`;
}
