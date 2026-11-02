// 終端機的觸控捲動。
//
// xterm 6 的 viewport 換成 VS Code 的 SmoothScrollableElement，只吃滑鼠滾輪、完全不處理觸控；
// 在手機上手指上下拖，手勢一路傳到 <html>，結果變成瀏覽器的「下拉重新整理」。
// 這裡自己接 touch 事件：
//   - 一般畫面（normal buffer、app 沒開滑鼠追蹤）：把像素換成行數，term.scrollLines()，內容跟著手指走
//   - app 開了滑鼠追蹤（vt200 / drag / any）：轉成滾輪事件給 xterm，讓 app 收到 wheel report
//   - alt buffer 且沒開滑鼠追蹤：吃掉手勢、什麼都不送（不送 ↑/↓，免得在 prompt 裡翻到輸入歷史）
//   - 跟隨模式（容器比畫面大）：先捲容器，捲到底了剩下的再交給終端機
// 放開後有慣性；新的觸碰、捲到頂 / 底、切換 session、unmount 都會停。
// 頁面被雙指放大時不接手（交給瀏覽器平移）；觸碰 xterm 的捲軸不讓它跳位置。
// 點一下（沒移動、夠短、單指、不是用來停慣性的）先問 onTap：落在連結上就由它處理（開連結面板），
// 並且取消這次觸碰的預設行為——不會變成滑鼠點擊送進 PTY，也不會 focus xterm、跳出鍵盤。
//
// 上半部是純函式（不碰 DOM，node --test 可直接測），下半部 attachTerminalTouch 才接 DOM。
//
// 方向約定：delta 為正 = 往「新的」方向捲（像 scrollTop 變大，手指往上推）；
// 手指往下拖 → delta 為負 → 畫面往上、看到歷史。

/** 手指移動超過這個距離（CSS px）才算拖曳；之內的仍是點擊（點一下要能 focus、叫出鍵盤） */
export const SLOP_PX = 10;
/** 放開時用最後這段時間的移動估速度 */
export const VELOCITY_WINDOW_MS = 100;
/** 慣性衰減的時間常數：速度每 TAU 毫秒剩 1/e */
export const INERTIA_TAU_MS = 325;
/** 放開時速度超過這個值（px/ms）才啟動慣性 */
export const MIN_FLING_VELOCITY = 0.25;
/** 慣性速度低於這個值（px/ms）就停 */
export const STOP_VELOCITY = 0.02;
/** 單一 frame 最多算這麼久（分頁被切到背景再回來時，不要一口氣跳一大段） */
export const MAX_FRAME_MS = 50;
/** 每一步最多送幾個滾輪事件給 app（快速甩動時不要一次灌爆 PTY） */
export const MAX_WHEEL_PER_STEP = 8;
/** 放開時的速度上限（px/ms，約等於 Android / iOS 原生捲動的上限 8000px/s）：估錯也不會一口氣飛上千行 */
export const MAX_FLING_VELOCITY = 8;
/** 估速度的取樣至少要跨這麼久（ms）；太短代表事件是擠在一起送來的，估出來的速度不可信 */
export const MIN_VELOCITY_SPAN_MS = 8;
/** visualViewport.scale 超過 1 + 這個值就算「頁面被放大了」：手勢交還給瀏覽器平移 */
export const ZOOM_EPSILON = 0.01;
/** 按住超過這麼久再放開就不算「點一下」（長按留給瀏覽器） */
export const TAP_MAX_MS = 500;

const MOUSE_WHEEL_MODES = new Set(['vt200', 'drag', 'any']);

/**
 * 依 buffer 與滑鼠追蹤狀態決定觸控捲動要做什麼。
 * x10 只回報按下、不回報滾輪，跟沒開一樣處理。
 * @returns {'lines' | 'wheel' | 'none'}
 */
export function pickScrollMode({ alt = false, mouseTracking = 'none' } = {}) {
  if (MOUSE_WHEEL_MODES.has(mouseTracking)) return 'wheel';
  if (alt) return 'none';
  return 'lines';
}

/** 超過 slop 才鎖定方向；回傳 null（還不算拖曳）、'x' 或 'y'。斜 45 度算垂直 */
export function resolveAxis(dx, dy, slop = SLOP_PX) {
  if (!(Math.hypot(dx, dy) >= slop)) return null;
  return Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
}

/**
 * 把像素累積成行數：回傳這次要捲的整數行（朝 0 截斷）與剩下的小數（帶到下一次）。
 * @param {number} acc 上次剩下的行數小數
 * @param {number} px 這次的位移（正 = 往新的方向）
 * @param {number} cellH 一行的高度（CSS px）
 */
export function accumulateLines(acc, px, cellH) {
  if (!(cellH > 0) || !Number.isFinite(px)) return { lines: 0, acc: Number.isFinite(acc) ? acc : 0 };
  const total = (Number.isFinite(acc) ? acc : 0) + px / cellH;
  // 加一點 epsilon：0.1 累加 10 次是 0.9999999…，不能因為浮點誤差少捲一行
  const lines = Math.trunc(total + Math.sign(total) * 1e-9);
  return { lines: lines === 0 ? 0 : lines, acc: total - lines };
}

/**
 * 由取樣估計放開時的速度（px/ms）。
 * t 要用事件自己的 timeStamp（手指實際移動的時間），不是處理事件的時間：
 * 主執行緒忙的時候（例如 Claude Code 正在大量輸出），排隊的 touchmove 會一口氣處理完，
 * 用處理時間算會得到接近 0 的時間差、估出超大的速度，慢慢拖也會變成飛很遠。
 * 時間差太短就當作不甩，結果也夾在 ±MAX_FLING_VELOCITY 內。
 * @param {{ t: number, p: number }[]} samples 由舊到新；p 是沿鎖定軸的累計位移（正 = 往新的方向）
 * @param {number} now 放開的時間（與 t 同一個時鐘）
 */
export function estimateVelocity(samples, now, windowMs = VELOCITY_WINDOW_MS) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (!(dt >= MIN_VELOCITY_SPAN_MS)) return 0;
  // 手指停住一陣子才放開：最後一次移動離放開太久就不甩
  if (now - b.t > windowMs / 2) return 0;
  const v = (b.p - a.p) / dt;
  return Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, v));
}

/**
 * 這次觸碰算不算「點一下」：沒超過 slop（還在 pending）、單指、時間夠短、不是用來停住慣性的、頁面沒被放大。
 */
export function isTap({ pending = false, fingers = 1, durationMs = 0, stoppedFling = false, zoomed = false } = {}) {
  return pending && fingers === 1 && !stoppedFling && !zoomed &&
    Number.isFinite(durationMs) && durationMs >= 0 && durationMs < TAP_MAX_MS;
}

/** 頁面是否被雙指放大了 */
export function isZoomed(scale, eps = ZOOM_EPSILON) {
  return Number.isFinite(scale) && scale > 1 + eps;
}

/**
 * 慣性的一步：速度指數衰減，位移是這段時間速度的積分，跟 frame rate 無關
 * （60Hz 走兩步 = 30Hz 走一步）。
 */
export function inertiaStep(velocity, dt, tau = INERTIA_TAU_MS) {
  const t = Math.max(0, Math.min(dt, MAX_FRAME_MS));
  const k = Math.exp(-t / tau);
  return { delta: velocity * tau * (1 - k), velocity: velocity * k };
}

/**
 * 在 [0, max] 範圍內捲動容器：回傳容器吃掉的量與剩下要交給終端機的量。
 * pos 已經超出範圍時不會往反方向「吃」。
 */
export function clampScroll(pos, max, delta) {
  const m = Math.max(0, max);
  let consumed = 0;
  if (delta > 0) consumed = Math.min(delta, Math.max(0, m - pos));
  else if (delta < 0) consumed = Math.max(delta, -Math.max(0, pos));
  consumed = consumed || 0; // 不回傳 -0
  return { consumed, rest: delta - consumed };
}

// ───────────────────────── DOM ─────────────────────────

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

const now = () => performance.now();

// 事件發生的時間（與 performance.now() 同一個時鐘）；拿不到就用現在
function eventTime(ev) {
  const t = ev && ev.timeStamp;
  return Number.isFinite(t) && t > 0 ? t : now();
}

function pageZoomed() {
  try { return isZoomed(window.visualViewport?.scale); } catch { return false; }
}

// 從這些元素開始的觸碰不讓 xterm 收到 touch 的 pointerdown：
// xterm 6 的捲軸（VS Code 的 scrollbar）會對 touch 的 pointerdown 直接跳到該位置或開始拖滑塊，
// 跟我們的觸控捲動打架（一碰右邊那條就跳好幾百行）。滑鼠不受影響（桌機照樣能拖捲軸）。
const TOUCH_BLOCKED_POINTERDOWN = '.xterm .scrollbar';
// 從這些元素開始的觸碰仍是一般按鈕：慣性中點它照樣要觸發（不當作「停住慣性」吃掉點擊）
const CONTROL_SELECTOR = 'button, a[href], [role="button"]';

function closestIn(target, selector, root) {
  const hit = target && typeof target.closest === 'function' ? target.closest(selector) : null;
  return hit && (!root || typeof root.contains !== 'function' || root.contains(hit)) ? hit : null;
}

/**
 * 在終端機區塊上接觸控捲動。
 *
 * @param {HTMLElement} el 接觸控事件的元素（TerminalPane 的 .pane：包含終端機容器與疊在上面的「↓ 最新」）
 * @param {object} opts
 * @param {HTMLElement} [opts.scroller] 跟隨模式下會捲動的容器（TerminalPane 的 .viewport）；預設 = el
 * @param {() => (null | {
 *   mode(): 'lines' | 'wheel' | 'none',
 *   cellHeight(): number,
 *   scrollLines(n: number): number,
 *   canScroll(dir: number): boolean,
 *   wheel(lines: number, x: number, y: number): void,
 * })} opts.resolve 手勢開始時呼叫，取得「目前這個 session」的終端機（切換 session 會重用同一個 TerminalPane）
 * @param {(x: number, y: number) => boolean} [opts.onTap] 點一下時呼叫（client 座標）；回傳 true = 已處理，
 *   這次觸碰不再變成點擊（不送滑鼠事件、不 focus）
 * @returns {{ stop(): void, dispose(): void }}
 */
export function attachTerminalTouch(el, { resolve, scroller, onTap } = {}) {
  const sc = scroller || el;
  // idle：沒有手勢；pending：一根手指按著、還沒超過 slop；drag：已認定是拖曳；ignore：多指，等全部放開
  let phase = 'idle';
  let target = null;
  let axis = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let travel = 0;          // 沿鎖定軸的累計位移（給估速度用）
  let samples = [];
  let lineAcc = 0;
  const virt = { x: null, y: null }; // 容器的小數捲動位置（瀏覽器可能把 scrollTop 取整）
  let raf = 0;
  let velocity = 0;
  let lastFrame = 0;
  let stoppedFling = false;  // 這次觸碰是用來停住慣性的：放開時不要變成點擊
  let startT = 0;            // 按下的時間（判斷是不是「點一下」）
  let startOnControl = false; // 從按鈕 / 捲軸上開始的觸碰：不問 onTap

  function stopInertia() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    velocity = 0;
  }

  function reset() {
    phase = 'idle';
    target = null;
    axis = null;
    samples = [];
    lineAcc = 0;
    virt.x = null;
    virt.y = null;
  }

  // 容器（跟隨模式才會有捲動空間）：回傳沒吃完、要交給終端機的量
  function scrollContainer(ax, delta) {
    const isY = ax === 'y';
    const max = isY ? sc.scrollHeight - sc.clientHeight : sc.scrollWidth - sc.clientWidth;
    if (max <= 0) return delta;
    const actual = isY ? sc.scrollTop : sc.scrollLeft;
    let pos = virt[ax];
    if (pos == null || Math.abs(pos - actual) > 1) pos = actual;
    const { consumed, rest } = clampScroll(pos, max, delta);
    if (consumed) {
      pos += consumed;
      if (isY) sc.scrollTop = pos;
      else sc.scrollLeft = pos;
    }
    virt[ax] = pos;
    return rest;
  }

  // 終端機：回傳 true = 這個方向已經捲不動（給慣性判斷要不要停）
  function scrollTerminal(delta, x, y) {
    if (!target || !delta) return false;
    const mode = target.mode();
    if (mode === 'none') {
      lineAcc = 0;
      return true;
    }
    const dir = Math.sign(delta);
    const r = accumulateLines(lineAcc, delta, target.cellHeight());
    lineAcc = r.acc;
    if (mode === 'wheel') {
      if (r.lines) target.wheel(Math.sign(r.lines) * Math.min(Math.abs(r.lines), MAX_WHEEL_PER_STEP), x, y);
      return false;
    }
    if (!r.lines) {
      if (target.canScroll(dir)) return false;
      lineAcc = 0;
      return true;
    }
    const moved = target.scrollLines(r.lines);
    if (moved !== r.lines) {
      lineAcc = 0;
      return true;
    }
    return false;
  }

  // 套用一段位移；回傳 true = 容器和終端機都捲不動了
  function apply(ax, delta, x, y) {
    const rest = scrollContainer(ax, delta);
    if (!rest) return false;
    if (ax !== 'y') return true; // 終端機只有垂直方向
    return scrollTerminal(rest, x, y);
  }

  function frame(t) {
    raf = 0;
    if (!target || !velocity) return;
    const dt = t - lastFrame;
    lastFrame = t;
    const step = inertiaStep(velocity, dt);
    velocity = step.velocity;
    const blocked = apply(axis, step.delta, lastX, lastY);
    if (blocked || Math.abs(velocity) < STOP_VELOCITY) {
      stopInertia();
      reset();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function onPointerDown(ev) {
    if (ev.pointerType === 'touch' && closestIn(ev.target, TOUCH_BLOCKED_POINTERDOWN, el)) ev.stopPropagation();
  }

  function onTouchStart(ev) {
    // 不在 touchstart preventDefault：點一下仍要 focus xterm 的 textarea、叫出鍵盤
    // 點在按鈕上（「↓ 最新」）就算慣性中也照常觸發點擊
    startOnControl = !!closestIn(ev.target, CONTROL_SELECTOR, el) || !!closestIn(ev.target, TOUCH_BLOCKED_POINTERDOWN, el);
    stoppedFling = !!raf && !closestIn(ev.target, CONTROL_SELECTOR, el);
    startT = eventTime(ev);
    stopInertia();
    // 頁面被雙指放大時，單指拖曳交給瀏覽器平移畫面（CSS 那邊也同時放開 touch-action），不然會被困在放大的終端機上
    if (ev.touches.length !== 1 || pageZoomed()) {
      reset();
      phase = 'ignore';
      return;
    }
    // 只剩這一根手指在螢幕上 = 新的手勢（之前的多指手勢已經全部放開）
    reset();
    const t = ev.touches[0];
    target = typeof resolve === 'function' ? resolve() : null;
    if (!target) return;
    phase = 'pending';
    startX = lastX = t.clientX;
    startY = lastY = t.clientY;
    travel = 0;
  }

  function onTouchMove(ev) {
    if (phase === 'idle' || phase === 'ignore') return;
    if (ev.touches.length !== 1) {
      reset();
      phase = 'ignore';
      return;
    }
    const t = ev.touches[0];
    if (phase === 'pending') {
      const a = resolveAxis(t.clientX - startX, t.clientY - startY);
      if (!a) return;
      // 從認定的這一點開始跟手，不補 slop 那一段（不會一開始就跳一下）
      axis = a;
      phase = 'drag';
      lastX = t.clientX;
      lastY = t.clientY;
      samples = [{ t: eventTime(ev), p: 0 }];
    }
    if (ev.cancelable) ev.preventDefault();
    const delta = axis === 'y' ? lastY - t.clientY : lastX - t.clientX;
    lastX = t.clientX;
    lastY = t.clientY;
    if (!delta) return;
    travel += delta;
    const ts = eventTime(ev);
    samples.push({ t: ts, p: travel });
    // 只留估速度需要的那一段
    while (samples.length > 2 && ts - samples[0].t > VELOCITY_WINDOW_MS * 2) samples.shift();
    apply(axis, delta, lastX, lastY);
  }

  function onTouchEnd(ev) {
    if (phase === 'ignore') {
      if (ev.touches.length === 0) phase = 'idle';
      return;
    }
    if (phase === 'drag') {
      // 拖曳結束：不要再被當成點擊
      if (ev.cancelable) ev.preventDefault();
      const v = estimateVelocity(samples, eventTime(ev));
      if (ev.type === 'touchend' && Math.abs(v) >= MIN_FLING_VELOCITY && !prefersReducedMotion()) {
        velocity = v;
        lastFrame = now();
        phase = 'idle';
        raf = requestAnimationFrame(frame);
        return;
      }
      reset();
      return;
    }
    // 只是點一下：如果這下是用來停住慣性的，不要變成點擊（不 focus、不跳鍵盤）
    if (phase === 'pending' && stoppedFling && ev.cancelable) ev.preventDefault();
    // 點在連結上：交給 onTap，並取消這次觸碰之後的滑鼠相容事件與 focus
    else if (ev.type === 'touchend' && typeof onTap === 'function' && !startOnControl && isTap({
      pending: phase === 'pending',
      fingers: (ev.touches?.length ?? 0) + (ev.changedTouches?.length ?? 1),
      durationMs: eventTime(ev) - startT,
      stoppedFling,
      zoomed: pageZoomed(),
    })) {
      const t = ev.changedTouches?.[0];
      let handled = false;
      try { handled = onTap(t ? t.clientX : startX, t ? t.clientY : startY) === true; } catch { handled = false; }
      if (handled && ev.cancelable) ev.preventDefault();
    }
    stoppedFling = false;
    reset();
  }

  el.addEventListener('pointerdown', onPointerDown, true);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd, { passive: false });
  el.addEventListener('touchcancel', onTouchEnd, { passive: false });

  return {
    // 切換 session：停掉慣性、丟掉進行中的手勢（舊 session 的 target）
    stop() {
      stopInertia();
      reset();
      stoppedFling = false;
      startOnControl = false;
    },
    dispose() {
      stopInertia();
      reset();
      el.removeEventListener('pointerdown', onPointerDown, true);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    },
  };
}
