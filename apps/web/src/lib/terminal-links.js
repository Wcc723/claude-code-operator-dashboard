// 終端機裡的網址：偵測、換行接回、能不能開、怎麼顯示。
//
// 兩種來源：
//   1. OSC 8 超連結（Claude Code 印的連結）：xterm 自己解析，這裡只判斷「能不能當網頁開」
//   2. 純文字網址（工具 / bash 印的 http://localhost:5173 之類）：這裡自己找
// 純文字網址常被切成好幾行：
//   - xterm 自動換行（soft wrap，IBufferLine.isWrapped）：直接接起來
//   - Ink（Claude Code）自己把長字串切成好幾行（hard wrap），續行前面還有縮排（通常 2 格）。
//     Ink 用 wrap-ansi：只有「比一整行還長的字」（空白之間的一串）才會被硬切，切的那一行剛好寫到最右邊一格。
//     所以要接回去必須：上一行寫到最右邊（cols-1）、最後一格是網址字元；下一行有縮排（至少 1 格、不比網址開頭深）、
//     開頭也是網址字元、不是新的 http(s)://；而且上一行尾端那個字加上下一行開頭那個字，比一整行（cols − 縮排）還寬
//     ——不然 Ink 根本不會切它，那只是「網址剛好寫到行尾、下一個字換到下一行」。最多接 MAX_HARD_JOIN_ROWS 行。
//
// 全部是純函式（不碰 DOM）：buffer 只透過 getLine(y) 拿「像 xterm IBufferLine 的東西」
// （isWrapped、length、getCell(x, cell) → { getChars(), getWidth() }、translateToString(trimRight)），
// node --test 可以用假的 buffer 測。座標一律 0-based（x = 欄、y = buffer 裡的行），
// 給 xterm 的 range 才轉成 1-based（toXtermRange）。

/** Ink 硬換行最多接幾行（含第一行）；手機 41 欄約 2500 字、桌面 107 欄約 6700 字 */
export const MAX_HARD_JOIN_ROWS = 64;
/** 往上 / 往下最多看幾行（一整段自動換行很長時，太遠的不找） */
export const MAX_BLOCK_ROWS = 64;
/**
 * 「寫到右邊緣」：最後一個有字的格子離 cols-1 最多差幾格。
 * Claude Code（Ink）的硬換行會寫滿到 cols-1（實際 session log：41 欄的終端機，切開的網址那一行寫到第 40 格），
 * 所以是 0；差一格的多半只是剛好寫到那裡、下一個字換行了。
 */
export const EDGE_SLACK = 0;
/** 一個網址最多幾個字（UTF-16）：防止一大片沒有空白的輸出讓偵測變慢；正常網址遠低於這個 */
export const MAX_URL_CHARS = 16384;
/** 連結清單最多幾筆 */
export const MAX_LINK_LIST = 50;
/** 畫面上最多顯示幾個字（複製一律用完整網址） */
export const MAX_DISPLAY_CHARS = 2000;

const SCHEME_RE = /https?:\/\//giy;
const SCHEME_SEARCH_RE = /https?:\/\//gi;
// 句尾標點、markdown 的粗體 **、表格的 |
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '*', '|']);
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/**
 * 這個 code point 會讓網址結束嗎？
 * 空白、控制字元、< > " ' `、CJK 文字與全形標點、一般標點（“ ” … —）、框線（│）、符號（⏺ ⎿）、emoji、私用區。
 * 拉丁字母（含 ü 之類的 IDN）、數字、ASCII 標點都算網址字元。
 */
export function isUrlStopCode(cp) {
  if (!Number.isFinite(cp)) return true;
  if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0)) return true; // 空白、C0、DEL、C1、NBSP
  switch (cp) {
    case 0x22: case 0x27: case 0x3c: case 0x3e: case 0x60: return true; // " ' < > `
    default: break;
  }
  if (cp >= 0x2000 && cp <= 0x2bff) return true;   // 一般標點、箭頭、技術符號（⏺ ⎿）、框線、方塊、幾何、雜項符號、裝飾符號
  if (cp >= 0x2e00 && cp <= 0xa4cf) return true;   // 補充標點、CJK 部首、、。「」《》、假名、注音、CJK 統一表意文字
  if (cp >= 0xa960 && cp <= 0xa97f) return true;   // 韓文字母擴充
  if (cp >= 0xac00 && cp <= 0xd7ff) return true;   // 韓文音節
  if (cp >= 0xe000 && cp <= 0xf8ff) return true;   // 私用區（Nerd Font 圖示）
  if (cp >= 0xf900 && cp <= 0xfaff) return true;   // CJK 相容表意文字
  if (cp >= 0xfe10 && cp <= 0xfe1f) return true;   // 直排標點
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true;   // CJK 相容形式、小寫變體
  if (cp >= 0xfeff && cp <= 0xffff) return true;   // BOM、全形標點（，！？：；（）＃）、半形片假名、�
  if (cp >= 0x1f000 && cp <= 0x1faff) return true; // emoji
  if (cp >= 0x20000 && cp <= 0x3ffff) return true; // CJK 擴充 B 以後
  return false;
}

/** 字串（一格的內容）的第一個 code point 會讓網址結束嗎？空字串算結束 */
export function isUrlStopChar(ch) {
  if (!ch) return true;
  return isUrlStopCode(ch.codePointAt(0));
}

/**
 * 去掉網址尾巴不屬於網址的東西：句尾標點 . , ; : ! ?、markdown 的 *、表格的 |，以及沒有配對的 ) ] }
 * （維基百科的 Foo_(bar) 這種成對的括號保留）。
 * 括號只數一次、從尾巴往回扣，O(n)：一大串 ))))) 也不會卡住頁面。
 */
export function trimUrlTail(url) {
  let n = null; // 尾巴碰到 ) ] } 才數一次
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (TRAILING_PUNCT.has(last)) {
      end--;
      continue;
    }
    const open = CLOSERS[last];
    if (open && !n) {
      n = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
      for (let i = 0; i < end; i++) {
        const c = url[i];
        if (c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}') n[c]++;
      }
    }
    if (open && n[last] > n[open]) {
      n[last]--;
      end--;
      continue;
    }
    break;
  }
  return end === url.length ? url : url.slice(0, end);
}

// scheme 後面至少要有一個像主機名稱開頭的字元
function plausible(url) {
  const m = /^https?:\/\/(.)/i.exec(url);
  return !!m && !/[/?#.:@]/.test(m[1]);
}

/**
 * 在一段文字裡找 http:// / https:// 網址。
 * @returns {{ start: number, end: number, rawEnd: number, url: string }[]} UTF-16 index；end 不含；
 *   rawEnd = 去掉尾巴標點前的結尾
 */
export function findUrls(text) {
  const out = [];
  if (!text) return out;
  SCHEME_SEARCH_RE.lastIndex = 0;
  let m;
  while ((m = SCHEME_SEARCH_RE.exec(text))) {
    const start = m.index;
    // 前面緊接英數字（xhttp://）：不是網址開頭
    if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue;
    let end = start + m[0].length;
    const limit = Math.min(text.length, start + MAX_URL_CHARS);
    while (end < limit) {
      const cp = text.codePointAt(end);
      if (isUrlStopCode(cp)) break;
      // 黏在一起的下一個網址（a.com/x,https://b.com）：在 , ; | 這裡斷開
      if ((cp === 0x2c || cp === 0x3b || cp === 0x7c) && startsWithScheme(text, end + 1)) break;
      end += cp > 0xffff ? 2 : 1;
    }
    const url = trimUrlTail(text.slice(start, end));
    if (plausible(url)) out.push({ start, end: start + url.length, rawEnd: end, url });
    // 從網址結尾繼續找（網址裡的 ?u=https://… 不再算一個）
    SCHEME_SEARCH_RE.lastIndex = Math.max(end, start + m[0].length);
  }
  return out;
}

function startsWithScheme(s, i) {
  SCHEME_RE.lastIndex = i;
  return SCHEME_RE.test(s);
}

// ───────────────────────── buffer → 文字 ─────────────────────────

const isBlank = (ch) => ch === '' || ch === ' ';

/**
 * 讀一行：只留「格子的開頭」（寬字元的右半格 width 0 不算），空格子的 ch = ''
 * @returns {{ y: number, wrapped: boolean, cells: { ch: string, x: number, w: number }[] }}
 */
export function readRow(line, y, cols, cell) {
  const cells = [];
  const n = Math.min(line?.length ?? 0, cols);
  for (let x = 0; x < n; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    const w = c.getWidth();
    if (w === 0) continue;
    cells.push({ ch: c.getChars(), x, w });
  }
  return { y, wrapped: !!line?.isWrapped, cells };
}

function lastNonBlank(cells) {
  for (let i = cells.length - 1; i >= 0; i--) if (!isBlank(cells[i].ch)) return i;
  return -1;
}

function firstNonBlank(cells) {
  for (let i = 0; i < cells.length; i++) if (!isBlank(cells[i].ch)) return i;
  return -1;
}

/**
 * 快速判斷：next 這一行可能接在 prev 後面嗎（自動換行，或像 Ink 的硬換行）。
 * 只看 prev 右邊緣的兩格和 next 的第一個字；縮排深度等細節由 buildBlockText 再判斷。
 */
export function rowsMayJoin(prev, next, cols, cell, nextText) {
  if (!prev || !next) return false;
  if (next.isWrapped) return true;
  let last = '';
  const plen = Math.min(prev.length, cols);
  for (let x = cols - 1; x >= Math.max(0, cols - 1 - EDGE_SLACK); x--) {
    if (x >= plen) continue;
    const c = prev.getCell(x, cell);
    if (!c) continue;
    // 寬字元的右半格：寬字元一定不是網址字元
    if (c.getWidth() === 0) return false;
    const ch = c.getChars();
    if (!isBlank(ch)) { last = ch; break; }
  }
  if (!last || isUrlStopChar(last)) return false;
  const t = nextText ?? next.translateToString(true);
  let i = 0;
  while (i < t.length && t[i] === ' ') i++;
  if (i === 0 || i >= t.length) return false;
  return !isUrlStopChar(t.slice(i, i + 2)) && !startsWithScheme(t, i);
}

/**
 * 把一段連續的行接成一串文字，記住每個 UTF-16 字元來自哪一格。
 * 行與行之間：自動換行直接接；符合 Ink 硬換行條件的去掉縮排再接；其他插入 '\n'。
 * 每一行只往回 / 往前看自己的格子（O(行寬)），不回頭掃整段文字；
 * 「尾端網址字元連續段從哪一格開始」只在要判斷硬換行時才算，算過的行記起來。
 * @param {{ y: number, wrapped: boolean, cells: { ch: string, x: number, w: number }[] }[]} rows 由上到下、連續
 * @returns {{ text: string, rowOf: number[], xOf: number[], wOf: number[] }}
 */
export function buildBlockText(rows, cols) {
  let text = '';
  const rowOf = [];
  const xOf = [];
  const wOf = [];
  let hardRun = 1; // 目前這串硬換行已經接了幾行
  const span = [];  // 每一行接進來的範圍 { from, to, joined }，tok = 算過的 tokX

  const push = (s, y, x, w) => {
    text += s;
    for (let k = 0; k < s.length; k++) { rowOf.push(y); xOf.push(x); wOf.push(w); }
  };

  // 第 r 行尾端「網址字元連續段」從哪一格開始（-1 = 沒有）；整行（從接上來的地方起）都是同一串時，
  // 開頭在更上面那一行。往上走到答案確定的那一行，再往下填回快取，所以每一行最多掃一次
  const tokXOf = (r) => {
    const chain = [];
    let k = r;
    let base = -1;
    for (;;) {
      const sp = span[k];
      if (sp.tok !== undefined) { base = sp.tok; break; }
      const cells = rows[k].cells;
      let ti = sp.to;
      while (ti >= sp.from && !isUrlStopChar(cells[ti].ch)) ti--;
      ti += 1;
      if (ti > sp.to) { sp.tok = -1; base = -1; break; }
      const x = cells[ti].x;
      if (ti === sp.from && sp.joined && k > 0) { sp.self = x; chain.push(k); k -= 1; continue; }
      sp.tok = x;
      base = x;
      break;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const sp = span[chain[i]];
      sp.tok = base >= 0 ? base : sp.self;
      base = sp.tok;
    }
    return span[r].tok;
  };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = row.cells;
    let from = 0;
    let joined = false;
    if (r > 0) {
      const prev = rows[r - 1];
      if (row.wrapped && prev.y === row.y - 1) {
        // 自動換行：同一個邏輯行，直接接
        joined = true;
      } else {
        if (prev.y === row.y - 1 && hardRun < MAX_HARD_JOIN_ROWS) joined = hardJoin(prev.cells, cells, cols, () => tokXOf(r - 1));
        if (joined) {
          from = firstNonBlank(cells);
          hardRun += 1;
        } else {
          push('\n', -1, -1, 0);
          hardRun = 1;
        }
      }
    }
    // 這一行要接到哪裡：下一行是自動換行 → 只丟掉尾端沒寫過的空格子（寬字元放不下留下的）；
    // 否則丟掉尾端所有空白
    const next = rows[r + 1];
    let to = cells.length - 1;
    if (next && next.wrapped && next.y === row.y + 1) {
      while (to >= from && cells[to].ch === '') to--;
    } else {
      while (to >= from && isBlank(cells[to].ch)) to--;
    }
    for (let i = from; i <= to; i++) {
      const c = cells[i];
      push(c.ch === '' ? ' ' : c.ch, row.y, c.x, c.w);
    }
    span.push({ from, to, joined });
  }
  return { text, rowOf, xOf, wOf };
}

/**
 * Ink 的硬換行：next 這一行是不是 prev 尾端那個字被切下來的續行。
 * @param {() => number} tokXOfPrev prev 尾端網址字元連續段開頭的格子（-1 = 沒有）；前面的條件都過了才算
 */
function hardJoin(prevCells, cells, cols, tokXOfPrev) {
  const pi = lastNonBlank(prevCells);
  const ni = firstNonBlank(cells);
  if (pi < 0 || ni < 0) return false;
  const pc = prevCells[pi];
  const nc = cells[ni];
  const right = pc.x + pc.w - 1;
  // prev 寫到右邊緣、最後一格是網址字元；next 開頭也是網址字元
  if (right < cols - 1 - EDGE_SLACK || isUrlStopChar(pc.ch) || isUrlStopChar(nc.ch)) return false;
  // 續行一定有縮排（Ink 的內容至少從第 2 格開始）、而且不比網址開頭深：
  // 一般 shell 輸出剛好寫滿一行後的下一行從第 0 格開始，不會被誤接
  if (nc.x < 1) return false;
  const tokX = tokXOfPrev();
  if (tokX < 0 || nc.x > tokX) return false;
  let head = '';
  for (let i = ni; i < cells.length && head.length < 8; i++) head += cells[i].ch || ' ';
  if (startsWithScheme(head, 0)) return false;
  // wrap-ansi 只硬切比一整行（cols − 縮排）還寬的字：prev 尾端那個字 + next 開頭那個字要比一整行寬，
  // 不然只是「這個字剛好寫到行尾、下一個字換到下一行」
  let wi = pi;
  while (wi > 0 && !isBlank(prevCells[wi - 1].ch)) wi--;
  let nj = ni;
  while (nj + 1 < cells.length && !isBlank(cells[nj + 1].ch)) nj++;
  const tail = right + 1 - prevCells[wi].x;
  const head1 = cells[nj].x + cells[nj].w - nc.x;
  return tail + head1 > right + 1 - nc.x;
}

/**
 * 一段文字裡的網址 → 每一行實際佔的格子。
 * @returns {{ url: string, segments: { y: number, x0: number, x1: number, soft: boolean }[] }[]}
 *   x1 含（寬字元算到右半格）；soft = 這一段是上一段的自動換行續行
 */
export function linksInBlock(rows, cols) {
  const { text, rowOf, xOf, wOf } = buildBlockText(rows, cols);
  const wrapped = new Map(rows.map((r) => [r.y, r.wrapped]));
  const out = [];
  for (const m of findUrls(text)) {
    const segments = [];
    let cur = null;
    let lastKey = '';
    for (let i = m.start; i < m.end; i++) {
      const y = rowOf[i];
      if (y < 0) continue;
      const key = `${y}:${xOf[i]}`;
      if (key === lastKey) continue; // 同一格（surrogate pair / 組合字元）
      lastKey = key;
      const x1 = xOf[i] + Math.max(1, wOf[i]) - 1;
      if (cur && cur.y === y) {
        cur.x1 = Math.max(cur.x1, x1);
      } else {
        cur = { y, x0: xOf[i], x1, soft: !!cur && cur.y === y - 1 && !!wrapped.get(y) && xOf[i] === 0 };
        segments.push(cur);
      }
    }
    if (segments.length) out.push({ url: m.url, segments });
  }
  return out;
}

/**
 * 把連結的格子換成 xterm 的 IBufferRange（1-based、end 含）。
 * 自動換行的相鄰段合成一個跨行的 range（hover 時整串一起畫底線）；
 * Ink 硬換行的每一行各自一個 range（縮排的格子不算在連結裡）。
 */
export function toXtermRanges(segments) {
  const ranges = [];
  let cur = null;
  for (const s of segments) {
    if (cur && s.soft) {
      cur.end = { x: s.x1 + 1, y: s.y + 1 };
    } else {
      cur = { start: { x: s.x0 + 1, y: s.y + 1 }, end: { x: s.x1 + 1, y: s.y + 1 } };
      ranges.push(cur);
    }
  }
  return ranges;
}

/** (x, y)（0-based）在不在 range 裡；跟 xterm Linkifier 一樣把座標攤平比較 */
export function rangeContains(range, x, y, cols) {
  const lower = range.start.y * cols + range.start.x;
  const upper = range.end.y * cols + range.end.x;
  const cur = (y + 1) * cols + (x + 1);
  return lower <= cur && cur <= upper;
}

/** 包含第 y 行、可能互相接續的那一段行 [top, bottom] */
export function blockAround(getLine, y, total, cols, cell) {
  let top = y;
  let bottom = y;
  while (top > 0 && y - top < MAX_BLOCK_ROWS && rowsMayJoin(getLine(top - 1), getLine(top), cols, cell)) top--;
  while (bottom < total - 1 && bottom - y < MAX_BLOCK_ROWS && rowsMayJoin(getLine(bottom), getLine(bottom + 1), cols, cell)) bottom++;
  return [top, bottom];
}

function readRows(getLine, top, bottom, cols, cell) {
  const rows = [];
  for (let r = top; r <= bottom; r++) {
    const line = getLine(r);
    if (!line) break;
    rows.push(readRow(line, r, cols, cell));
  }
  return rows;
}

/**
 * 第 y 行上的純文字網址（給 xterm 的 link provider 與點擊判斷）。
 * @returns {{ url: string, range: object, segments: object[] }[]} 只回傳碰到第 y 行的 range；
 *   segments = 整個網址在每一行佔的格子（給呼叫端檢查有沒有蓋到 OSC 8 連結）
 */
export function textLinksAtRow(getLine, y, total, cols, cell) {
  if (!(y >= 0 && y < total)) return [];
  const [top, bottom] = blockAround(getLine, y, total, cols, cell);
  const out = [];
  for (const link of linksInBlock(readRows(getLine, top, bottom, cols, cell), cols)) {
    for (const range of toXtermRanges(link.segments)) {
      if (range.start.y - 1 <= y && y <= range.end.y - 1) out.push({ url: link.url, range, segments: link.segments });
    }
  }
  return out;
}

/**
 * 整個 buffer（捲動紀錄 + 畫面）裡的純文字網址，由上到下。
 * 每一行只轉一次字串：先用字串判斷哪幾行可能接在一起、整段有沒有 http(s)://，有才逐格讀。
 * @returns {{ url: string, y: number, x: number, segments: object[] }[]} y / x = 網址開頭那一格
 */
export function scanTextLinks(getLine, total, cols, cell) {
  const out = [];
  let nextLine = total > 0 ? getLine(0) : null;
  let nextText = nextLine ? nextLine.translateToString(true) : '';
  for (let y = 0; y < total;) {
    const top = y;
    let line = nextLine;
    let joined = nextText;
    let bottom = y;
    for (;;) {
      if (bottom >= total - 1) break;
      const nl = getLine(bottom + 1);
      const nt = nl ? nl.translateToString(true) : '';
      if (bottom - top < MAX_BLOCK_ROWS && rowsMayJoin(line, nl, cols, cell, nt)) {
        bottom += 1;
        line = nl;
        joined += nt.trimStart();
      } else {
        nextLine = nl;
        nextText = nt;
        break;
      }
    }
    if (/https?:\/\//i.test(joined)) {
      for (const link of linksInBlock(readRows(getLine, top, bottom, cols, cell), cols)) {
        const s = link.segments[0];
        out.push({ url: link.url, y: s.y, x: s.x0, segments: link.segments });
      }
    }
    y = bottom + 1;
  }
  return out;
}

/** 純文字網址有沒有蓋到 OSC 8 連結的格子（OSC 8 優先，蓋到的純文字網址不算） */
export function overlapsRanges(segments, ranges, cols) {
  for (const s of segments) {
    for (const r of ranges) {
      const lo = r.start.y - 1 === s.y ? r.start.x - 1 : (r.start.y - 1 < s.y ? 0 : Infinity);
      const hi = r.end.y - 1 === s.y ? r.end.x - 1 : (r.end.y - 1 > s.y ? cols - 1 : -Infinity);
      if (lo <= s.x1 && s.x0 <= hi) return true;
    }
  }
  return false;
}

/**
 * 連結清單：越下面（越新）越前面、同一個網址只留最新的、最多 max 筆。
 * @param {{ url: string, y: number, x: number, osc?: boolean }[]} items
 */
export function mergeLinkList(items, max = MAX_LINK_LIST) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (b.x - a.x));
  const seen = new Set();
  const out = [];
  for (const it of sorted) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    out.push({ url: it.url, osc: !!it.osc });
    if (out.length >= max) break;
  }
  return out;
}

// ───────────────────────── 開啟 / 顯示 ─────────────────────────

/** 只有 http: / https: 可以當網頁開；回傳正規化後的網址，其他（javascript: data: file: blob:…）回傳 null */
export function webHref(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

export function isWebUrl(url) {
  return webHref(url) !== null;
}

/**
 * 「開啟」實際會去哪裡：正規化後、拿掉 @ 前面帳號密碼的網址，與主機名稱（IDN 是 punycode）。
 * 網址裡的 \ 會被當成 /（http://evil.example\@good.example/ 去的是 evil.example），所以面板要顯示這裡的 host。
 * @returns {null | { href: string, host: string, userinfo: boolean }}
 */
export function webTarget(url) {
  const href = webHref(url);
  if (!href) return null;
  const u = new URL(href);
  const userinfo = !!(u.username || u.password);
  u.username = '';
  u.password = '';
  return { href: u.href, host: u.host, userinfo };
}

/**
 * OSC 8 連結畫面上的字，看起來是不是就是它真正的目的地（裡面有網址、而且主機一樣）。
 * 不是的話（[這裡](https://…)、或畫面寫 accounts.google.com 實際卻去別處）⌘ / Ctrl+點不直接開，先給面板看清楚。
 */
export function visibleMatchesHref(visible, url) {
  const target = webTarget(url);
  if (!target || typeof visible !== 'string') return false;
  for (const m of findUrls(visible)) {
    if (webTarget(m.url)?.host === target.host) return true;
  }
  return false;
}

// 看不見、會改變顯示順序或把字藏起來的字元：控制字元、格式字元（雙向文字控制、零寬字元、tag 字元）、
// 行 / 段落分隔、落單的 surrogate、預設忽略的字元（軟連字號、韓文填充字、變體選擇符…）。顯示時換成 �
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * 顯示用的網址：看不見的字元換成 �，超過 max 個字截斷（複製仍用完整網址）。
 * @returns {{ text: string, truncated: boolean, replaced: boolean }} replaced = 有字元被換掉
 */
export function displayUrl(url, max = MAX_DISPLAY_CHARS) {
  const raw = String(url ?? '');
  const s = raw.replace(INVISIBLE_RE, '\uFFFD');
  const replaced = s !== raw;
  if (s.length <= max) return { text: s, truncated: false, replaced };
  // 不要切在 surrogate pair 中間
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return { text: `${s.slice(0, cut)}…`, truncated: true, replaced };
}
