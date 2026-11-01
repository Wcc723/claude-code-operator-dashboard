// 畫布視角（viewport）的純數學：螢幕座標 ↔ 世界座標、以某點為中心縮放、符合畫面、限制平移範圍。
// 不碰 DOM、不依賴 Vue，方便用 node 直接單元測試（CanvasBoard.vue 只負責把事件餵進來、把結果寫到 transform）。
//
// 座標約定
// - 世界座標（world）：canvas spec 裡 frame / 問答卡 / 說明卡 / 便利貼的 x、y（CSS px，scale = 1 時的大小）。
// - 螢幕座標（screen）：相對於畫布容器左上角的 CSS px（= clientX - 容器 rect.left）。
// - viewport：{ x, y, scale }，screen = world × scale + (x, y)；world div 的 transform 就是
//   `translate(x px, y px) scale(scale)`，transform-origin 0 0。
// 所有函式都回傳新物件，不改傳入的 viewport。

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2;
/** 拖曳門檻（螢幕 px）：小於這個距離的抖動不算拖曳，仍當成點擊 */
export const DRAG_THRESHOLD = 4;
/** + / − 按鈕依序跳的縮放比例 */
export const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 縮放比例夾在 [min, max]；非有限數字一律當 1 */
export function clampScale(scale, min = MIN_SCALE, max = MAX_SCALE) {
  return clamp(isNum(scale) && scale > 0 ? scale : 1, min, max);
}

export function identity() {
  return { x: 0, y: 0, scale: 1 };
}

/** 把任何輸入整理成合法的 viewport（壞值退回 identity 的對應欄位） */
export function normalizeViewport(vp, opts = {}) {
  return {
    x: isNum(vp?.x) ? vp.x : 0,
    y: isNum(vp?.y) ? vp.y : 0,
    scale: clampScale(vp?.scale, opts.min ?? MIN_SCALE, opts.max ?? MAX_SCALE),
  };
}

export function screenToWorld(vp, sx, sy) {
  return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale };
}

export function worldToScreen(vp, wx, wy) {
  return { x: wx * vp.scale + vp.x, y: wy * vp.scale + vp.y };
}

export function panBy(vp, dx, dy) {
  return { x: vp.x + (isNum(dx) ? dx : 0), y: vp.y + (isNum(dy) ? dy : 0), scale: vp.scale };
}

/**
 * 以螢幕上 (sx, sy) 為中心縮放到 nextScale：縮放前後該點底下的世界座標不變。
 * nextScale 會被夾在 [min, max]。
 */
export function zoomAt(vp, sx, sy, nextScale, { min = MIN_SCALE, max = MAX_SCALE } = {}) {
  const scale = clampScale(nextScale, min, max);
  const w = screenToWorld(vp, sx, sy);
  return { x: sx - w.x * scale, y: sy - w.y * scale, scale };
}

export function zoomBy(vp, sx, sy, factor, opts) {
  return zoomAt(vp, sx, sy, vp.scale * (isNum(factor) && factor > 0 ? factor : 1), opts);
}

/** 下一個（dir > 0）或上一個（dir < 0）縮放刻度；已經在刻度之間就跳到最近的那一格 */
export function nextZoomStep(scale, dir, steps = ZOOM_STEPS) {
  const eps = 1e-3;
  if (dir > 0) {
    const s = steps.find((v) => v > scale + eps);
    return s ?? steps[steps.length - 1];
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i] < scale - eps) return steps[i];
  }
  return steps[0];
}

/**
 * WheelEvent → 以 px 計的位移。deltaMode：0 = px、1 = 行、2 = 頁。
 * Windows 上 Shift + 滾輪只給 deltaY，轉成水平捲動。
 */
export function wheelDelta(e, { lineHeight = 16, pageWidth = 800, pageHeight = 600 } = {}) {
  let dx = isNum(e?.deltaX) ? e.deltaX : 0;
  let dy = isNum(e?.deltaY) ? e.deltaY : 0;
  if (e?.deltaMode === 1) {
    dx *= lineHeight;
    dy *= lineHeight;
  } else if (e?.deltaMode === 2) {
    dx *= pageWidth;
    dy *= pageHeight;
  }
  if (e?.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { dx, dy };
}

/** 每 px 的 ln(縮放倍率)：Chrome 的觸控板 pinch 會送 ctrlKey + deltaY ≈ −100·ln(倍率)，用 0.01 手指跟畫面同步 */
export const WHEEL_ZOOM_RATE = 0.01;
/** 單次事件的 delta 上限（px）：滑鼠滾輪一格（Chrome 約 100px、行模式 3 行 = 48px）都會被夾到這裡 ≈ 1.2 倍 */
export const WHEEL_ZOOM_MAX_DELTA = 18;
/** 單次事件的縮放倍率範圍（保險：任何輸入都不會一次跳太多） */
export const WHEEL_ZOOM_MIN_FACTOR = 0.8;
export const WHEEL_ZOOM_MAX_FACTOR = 1.25;

/**
 * Ctrl/⌘ + 滾輪（含觸控板 pinch，瀏覽器會送 ctrlKey + 小 deltaY）的縮放倍率；dy 是換算成 px 的 deltaY。
 * 觸控板 pinch 的 delta 很小（每次 1～10px）：照比例縮放，連續平滑、跟手指同步；
 * 滑鼠滾輪一格的 delta 大（~100px）：被夾在 ±WHEEL_ZOOM_MAX_DELTA，一格約 1.2 倍，不會一次跳 1.6 倍。
 */
export function wheelZoomFactor(dy) {
  const d = clamp(isNum(dy) ? dy : 0, -WHEEL_ZOOM_MAX_DELTA, WHEEL_ZOOM_MAX_DELTA);
  return clamp(Math.exp(-d * WHEEL_ZOOM_RATE), WHEEL_ZOOM_MIN_FACTOR, WHEEL_ZOOM_MAX_FACTOR);
}

/**
 * WheelEvent（或同形狀的物件）→ 縮放倍率：先依 deltaMode 換成 px（行 = lineHeight、頁 = pageHeight，
 * 呼叫端傳畫布高度），再交給 wheelZoomFactor。縮放只看 deltaY（Shift 不轉水平）。
 */
export function wheelEventZoomFactor(e, { lineHeight = 16, pageHeight = 600 } = {}) {
  let dy = isNum(e?.deltaY) ? e.deltaY : 0;
  if (e?.deltaMode === 1) dy *= lineHeight;
  else if (e?.deltaMode === 2) dy *= pageHeight;
  return wheelZoomFactor(dy);
}

/** 一組 { x, y, width, height } 的外框；沒有有效矩形回 null */
export function boundsOf(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects || []) {
    if (!r || !isNum(r.x) || !isNum(r.y)) continue;
    const w = isNum(r.width) && r.width > 0 ? r.width : 0;
    const h = isNum(r.height) && r.height > 0 ? r.height : 0;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + w);
    maxY = Math.max(maxY, r.y + h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** padding 可以是數字或 { top, right, bottom, left }（缺的邊當 0） */
export function normalizePadding(p) {
  if (isNum(p)) return { top: p, right: p, bottom: p, left: p };
  return {
    top: isNum(p?.top) ? p.top : 0,
    right: isNum(p?.right) ? p.right : 0,
    bottom: isNum(p?.bottom) ? p.bottom : 0,
    left: isNum(p?.left) ? p.left : 0,
  };
}

/**
 * 讓 bounds 整個放進 viewW × viewH（扣掉 padding）並置中。
 * 預設最多放大到 1（設計稿放大超過 100% 沒有意義），最小到 min。
 * 可用區域小於 1px（容器還沒排版）時退回 scale 1、對齊左上角。
 */
export function fitBounds(bounds, viewW, viewH, { padding = 48, min = MIN_SCALE, max = 1 } = {}) {
  if (!bounds) return identity();
  const pad = normalizePadding(padding);
  const availW = viewW - pad.left - pad.right;
  const availH = viewH - pad.top - pad.bottom;
  const bw = Math.max(bounds.width, 1);
  const bh = Math.max(bounds.height, 1);
  let scale;
  if (!(availW >= 1 && availH >= 1)) scale = clampScale(1, min, max);
  else scale = clampScale(Math.min(availW / bw, availH / bh), min, max);
  const x = pad.left + (Math.max(availW, 0) - bw * scale) / 2 - bounds.x * scale;
  const y = pad.top + (Math.max(availH, 0) - bh * scale) / 2 - bounds.y * scale;
  return { x, y, scale };
}

/** 保持縮放比例，把世界座標 (wx, wy) 移到畫面中央 */
export function centerOn(vp, wx, wy, viewW, viewH) {
  return { x: viewW / 2 - wx * vp.scale, y: viewH / 2 - wy * vp.scale, scale: vp.scale };
}

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 雙指 pinch：起始兩指 (a0, b0) 時的 viewport 是 start；現在兩指在 (a1, b1)。
 * 縮放倍率 = 兩指距離比；起始中點底下的世界座標跟著現在的中點走（同時處理平移與縮放）。
 */
export function pinchViewport(start, a0, b0, a1, b1, opts = {}) {
  const d0 = distance(a0, b0);
  const d1 = distance(a1, b1);
  const ratio = d0 > 0 && d1 > 0 ? d1 / d0 : 1;
  const scale = clampScale(start.scale * ratio, opts.min ?? MIN_SCALE, opts.max ?? MAX_SCALE);
  const m0 = midpoint(a0, b0);
  const m1 = midpoint(a1, b1);
  const w = screenToWorld(start, m0.x, m0.y);
  return { x: m1.x - w.x * scale, y: m1.y - w.y * scale, scale };
}

/**
 * 限制平移：內容外框（世界座標）在螢幕上至少要留 keep px 在可視範圍內，避免整個畫布被拖到看不見。
 * 內容本身比 keep 小時，改成要求整個內容都留在畫面內。縮放比例不變。
 */
export function constrainViewport(vp, bounds, viewW, viewH, keep = 80) {
  if (!bounds || !(viewW > 0) || !(viewH > 0)) return { ...vp };
  const left = bounds.x * vp.scale + vp.x;
  const top = bounds.y * vp.scale + vp.y;
  const w = bounds.width * vp.scale;
  const h = bounds.height * vp.scale;
  const kx = Math.min(keep, w, viewW);
  const ky = Math.min(keep, h, viewH);
  let x = vp.x;
  let y = vp.y;
  // 內容右緣不能跑到 kx 左邊；左緣不能跑到 viewW - kx 右邊
  if (left + w < kx) x += kx - (left + w);
  else if (left > viewW - kx) x -= left - (viewW - kx);
  if (top + h < ky) y += ky - (top + h);
  else if (top > viewH - ky) y -= top - (viewH - ky);
  return { x, y, scale: vp.scale };
}

/** 拖曳是否超過門檻（含門檻本身不算：剛好 4px 仍是點擊） */
export function exceedsThreshold(dx, dy, threshold = DRAG_THRESHOLD) {
  return dx * dx + dy * dy > threshold * threshold;
}

/** 動畫用：a → b 線性內插（t ∈ [0, 1]）。scale 用對數內插，縮放速度看起來比較均勻 */
export function lerpViewport(a, b, t) {
  const k = clamp(t, 0, 1);
  const scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * k);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, scale };
}

export function sameViewport(a, b, eps = 1e-6) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.scale - b.scale) < eps;
}

/** viewport → CSS transform 字串（world div 用；transform-origin 必須是 0 0） */
export function toTransform(vp) {
  return `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;
}
