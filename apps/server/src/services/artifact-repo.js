import { randomBytes } from 'node:crypto';

// CODD Artifact 的資料層：artifact / 版本 / 草稿 / 提交（SQLite，跟 kanban 同一個 DB）。
// - html kind 的內容是 HTML 字串；canvas kind 是 normalizeCanvasSpec() 正規化後的 JSON。
// - 使用者回覆（草稿與提交共用）一律經過 normalizePayload()：限長、驗證型別、丟掉未知欄位。
// - 錯誤一律 throw Error 並帶 err.status（400 / 404 / 409 / 413），訊息用繁中、指出哪個欄位，
//   route 與 MCP 工具直接把訊息回給呼叫端。

const KiB = 1024;
const MiB = 1024 * 1024;

export const DEFAULT_MAX_CONTENT_BYTES = 3 * MiB;
const MAX_CONTENT_FLOOR = 64 * KiB;
const MAX_CONTENT_CEIL = 64 * MiB;
export const FRAME_HTML_MAX_BYTES = 1.5 * MiB;
const PAYLOAD_MAX_BYTES = 1 * MiB;
const DATA_MAX_BYTES = 256 * KiB;

export const ARTIFACT_ID_RE = /^[a-z0-9]{12}$/;
export const ELEMENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// 會被 JS 物件當成特殊 key 的名字（answers 用 question id 當 key）
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const HTML_FRAME_ID = 'main';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KINDS = new Set(['html', 'canvas']);
const QUESTION_TYPES = new Set(['single', 'multi', 'text']);
export const CARD_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'];
const CARD_COLOR_SET = new Set(CARD_COLORS);
// skipped：輪到送的時候 artifact 已刪除、或那次提交 Claude 已經讀過了，不用再打通知
export const NOTIFY_STATUSES = ['none', 'pending', 'sent', 'no_session', 'expired', 'failed', 'disabled', 'skipped'];
const NOTIFY_STATUS_SET = new Set(NOTIFY_STATUSES);

const L = {
  title: 120,
  frames: 24,
  questions: 30,
  notes: 30,
  prompt: 1000,
  option: 200,
  optionsMin: 2,
  optionsMax: 12,
  noteText: 4000,
  versionNote: 2000,
  originLabel: 120,
  message: 8000,
  comments: 200,
  commentText: 4000,
  answerText: 4000,
  stickies: 100,
  stickyText: 2000,
  targetTag: 40,
  targetId: 100,
  targetText: 200,
  targetSelector: 300,
  targetClasses: 8,
  targetClass: 60,
};

const FRAME_W = { def: 1280, min: 120, max: 4000 };
const FRAME_H = { def: 800, min: 120, max: 4000 };
const QUESTION_W = { def: 320, min: 200, max: 1200 };
const NOTE_W = { def: 360, min: 160, max: 1200 };
const COORD_MAX = 1_000_000;
// 自動排版的間距（§3）
const FRAME_GAP = 80;
const COLUMN_GAP = 120;
const QUESTION_GAP = 40;
const NOTE_GAP = 40;

// ---------- 小工具 ----------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const bad = (msg) => httpError(400, msg);
const tooLarge = (msg) => httpError(413, msg);

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nowIso() {
  return new Date().toISOString();
}

// 比 prev 大的 ISO 時間（同一毫秒內就 +1 ms）
function nextStamp(prev) {
  let t = Date.now();
  const p = typeof prev === 'string' ? Date.parse(prev) : NaN;
  if (Number.isFinite(p) && t <= p) t = p + 1;
  return new Date(t).toISOString();
}

function bytesOf(s) {
  return Buffer.byteLength(s, 'utf8');
}

function fmtBytes(n) {
  if (n >= MiB) return `${Math.round((n / MiB) * 10) / 10} MiB`;
  return `${Math.round(n / KiB)} KiB`;
}

// 依 code point 計長度（中文、emoji 都算 1 字）
function charLen(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function truncateChars(s, max) {
  if (s.length <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}

// 單行文字：控制字元（C0 / C1 / U+2028 / U+2029）、bidi 控制字元（畫面上可以把字反轉、偽裝標題）、
// 零寬空白 / word joiner / BOM、tag 字元（U+E0000–E007F，看不見但模型讀得到）換成空白、壓縮空白、去頭尾。
// ZWJ / ZWNJ 與變化選擇符保留（emoji、部分文字需要）
const LINE_CTRL_RE = /[\p{Cc}\u{2028}\u{2029}\u{061C}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;
function cleanLine(v) {
  return String(v).replace(LINE_CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
}

// 多行文字：統一換行成 \n，保留 \t \n，其他控制字元拿掉（不去頭尾，草稿打字中的空白不要被吃掉）
const BLOCK_CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
function cleanBlock(v) {
  return String(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(BLOCK_CTRL_RE, '');
}

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// 數字欄位：不是有限數字就當沒給（回 null）
function coord(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(clampNum(v, -COORD_MAX, COORD_MAX));
}

function dim(v, { def, min, max }) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.round(clampNum(v, min, max));
}

function clampInt(v, min, max, def) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.trunc(clampNum(n, min, max));
}

function toVersion(v) {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// 字串欄位（Claude 給的）：可接受數字，其他型別 400
function asText(v, field) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw bad(`${field} 必須是字串`);
}

function lineField(v, field, max, { required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${field} 必填`);
    return null;
  }
  const s = cleanLine(asText(v, field));
  if (!s) {
    if (required) throw bad(`${field} 不能是空的`);
    return null;
  }
  if (charLen(s) > max) throw bad(`${field} 不能超過 ${max} 字（目前 ${charLen(s)} 字）`);
  return s;
}

function blockField(v, field, max) {
  if (v === undefined || v === null) throw bad(`${field} 必填`);
  const s = cleanBlock(asText(v, field)).trim();
  if (!s) throw bad(`${field} 不能是空的`);
  if (charLen(s) > max) throw bad(`${field} 不能超過 ${max} 字（目前 ${charLen(s)} 字）`);
  return s;
}

function clampMaxBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONTENT_BYTES;
  return Math.trunc(clampNum(n, MAX_CONTENT_FLOOR, MAX_CONTENT_CEIL));
}

// ---------- id ----------

// 12 字元 [a-z0-9]；用拒絕取樣避免 256 % 36 造成的偏差
export function newArtifactId() {
  let out = '';
  while (out.length < 12) {
    const buf = randomBytes(24);
    for (const b of buf) {
      if (b >= 252) continue; // 252 = 36 * 7
      out += ID_ALPHABET[b % 36];
      if (out.length === 12) break;
    }
  }
  return out;
}

export function normalizeTitle(v, field = 'title') {
  return lineField(v, field, L.title);
}

// ---------- canvas spec（§3）----------

/**
 * 驗證並補預設值。input 可以是物件或 JSON 字串。
 * opts.maxContentBytes：整個 spec 序列化後的上限（預設 3 MiB）
 */
export function normalizeCanvasSpec(input, opts = {}) {
  const maxContentBytes = clampMaxBytes(opts?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES);
  let spec = input;
  if (typeof spec === 'string') {
    if (bytesOf(spec) > maxContentBytes) throw tooLarge(`canvas 超過 ${fmtBytes(maxContentBytes)}`);
    try { spec = JSON.parse(spec); } catch { throw bad('canvas 不是合法的 JSON'); }
  }
  if (!isObj(spec)) throw bad('canvas 必須是物件（至少要有 frames 陣列）');

  const framesIn = spec.frames;
  if (!Array.isArray(framesIn) || framesIn.length === 0) throw bad('canvas.frames 至少要有 1 個 frame');
  if (framesIn.length > L.frames) throw bad(`canvas.frames 最多 ${L.frames} 個（目前 ${framesIn.length} 個）`);
  const questionsIn = spec.questions ?? [];
  if (!Array.isArray(questionsIn)) throw bad('canvas.questions 必須是陣列');
  if (questionsIn.length > L.questions) throw bad(`canvas.questions 最多 ${L.questions} 個（目前 ${questionsIn.length} 個）`);
  const notesIn = spec.notes ?? [];
  if (!Array.isArray(notesIn)) throw bad('canvas.notes 必須是陣列');
  if (notesIn.length > L.notes) throw bad(`canvas.notes 最多 ${L.notes} 個（目前 ${notesIn.length} 個）`);

  const groups = [
    ['frames', framesIn, 'f'],
    ['questions', questionsIn, 'q'],
    ['notes', notesIn, 'n'],
  ];

  // 第一輪：先收下有指定的 id（三種元素合起來不得重複），自動產生的 id 才能避開它們
  const used = new Set();
  const explicitIds = {};
  for (const [name, list] of groups) {
    explicitIds[name] = list.map((item, i) => {
      const path = `canvas.${name}[${i}]`;
      if (!isObj(item)) throw bad(`${path} 必須是物件`);
      const raw = item.id;
      if (raw === undefined || raw === null || raw === '') return null;
      if (typeof raw !== 'string' || !ELEMENT_ID_RE.test(raw) || RESERVED_KEYS.has(raw)) {
        throw bad(`${path}.id 只能用英數字、底線、連字號（1–40 字）`);
      }
      if (name === 'frames' && raw === HTML_FRAME_ID) throw bad(`${path}.id 不能是 "${HTML_FRAME_ID}"（保留字）`);
      if (used.has(raw)) throw bad(`${path}.id「${raw}」重複了（frames / questions / notes 的 id 不能重複）`);
      used.add(raw);
      return raw;
    });
  }
  const autoId = (prefix) => {
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    const id = `${prefix}${i}`;
    used.add(id);
    return id;
  };

  // frames
  const frames = framesIn.map((f, i) => {
    const path = `canvas.frames[${i}]`;
    const id = explicitIds.frames[i] ?? autoId('f');
    if (typeof f.html !== 'string' || !f.html.trim()) throw bad(`${path}.html 不能是空的（要放完整的 HTML）`);
    const htmlBytes = bytesOf(f.html);
    if (htmlBytes > FRAME_HTML_MAX_BYTES) {
      throw tooLarge(`${path}.html 超過 ${fmtBytes(FRAME_HTML_MAX_BYTES)}（目前 ${fmtBytes(htmlBytes)}）`);
    }
    return {
      id,
      title: lineField(f.title, `${path}.title`, L.title, { required: false }) ?? id,
      html: f.html,
      width: dim(f.width, FRAME_W),
      height: dim(f.height, FRAME_H),
      x: coord(f.x),
      y: coord(f.y),
    };
  });

  // questions
  const questions = questionsIn.map((q, i) => {
    const path = `canvas.questions[${i}]`;
    const id = explicitIds.questions[i] ?? autoId('q');
    const prompt = blockField(q.prompt, `${path}.prompt`, L.prompt);
    let type = q.type;
    if (type === undefined || type === null || type === '') type = Array.isArray(q.options) ? 'single' : 'text';
    if (!QUESTION_TYPES.has(type)) throw bad(`${path}.type 必須是 "single"、"multi" 或 "text"`);
    let options = [];
    if (type !== 'text') {
      if (!Array.isArray(q.options)) throw bad(`${path}.options 必須是陣列（${type} 題需要 ${L.optionsMin}–${L.optionsMax} 個選項）`);
      if (q.options.length < L.optionsMin || q.options.length > L.optionsMax) {
        throw bad(`${path}.options 要有 ${L.optionsMin}–${L.optionsMax} 個選項（目前 ${q.options.length} 個）`);
      }
      const seen = new Set();
      options = q.options.map((o, j) => {
        const s = lineField(o, `${path}.options[${j}]`, L.option);
        if (seen.has(s)) throw bad(`${path}.options[${j}]「${s}」重複了`);
        seen.add(s);
        return s;
      });
    }
    return { id, prompt, type, options, x: coord(q.x), y: coord(q.y), width: dim(q.width, QUESTION_W) };
  });

  // notes（Claude 寫給使用者的說明卡，唯讀）
  const notes = notesIn.map((n, i) => {
    const path = `canvas.notes[${i}]`;
    const id = explicitIds.notes[i] ?? autoId('n');
    return {
      id,
      text: blockField(n.text, `${path}.text`, L.noteText),
      x: coord(n.x),
      y: coord(n.y),
      width: dim(n.width, NOTE_W),
      color: CARD_COLOR_SET.has(n.color) ? n.color : 'yellow',
    };
  });

  layoutCanvas(frames, questions, notes);

  const out = { frames, questions, notes };
  const total = bytesOf(JSON.stringify(out));
  if (total > maxContentBytes) {
    throw tooLarge(`canvas 整體超過 ${fmtBytes(maxContentBytes)}（目前 ${fmtBytes(total)}）`);
  }
  return out;
}

// ---------- 自動排版 ----------
// 卡片高度估計（寧可高估，免得下一張蓋住）。對應 apps/web/src/components/artifact/CanvasQuestion.vue / CanvasNote.vue 的樣式：
// 題目 15.5px、行高 1.5；選項一列約 42px；text 題的 textarea 前端最多長到約 200px；說明卡 15px、行高 1.6
const FRAME_TITLE_H = 32; // frame 標題畫在 frame 上方
const LAYOUT_GUARD = 400;

// 寬字（CJK、全形、emoji）算 1 個字寬，其他算 0.6
function textUnits(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.codePointAt(0) >= 0x1100 ? 1 : 0.6;
  return n;
}

function wrappedLines(text, width, fontPx) {
  const perLine = Math.max(4, Math.floor(width / fontPx));
  let lines = 0;
  for (const para of String(text ?? '').split('\n')) lines += Math.max(1, Math.ceil(textUnits(para) / perLine));
  return lines;
}

function questionHeight(q) {
  const inner = q.width - 34;
  const prompt = wrappedLines(q.prompt, inner, 15.5) * 24;
  const body = q.type === 'text'
    ? 220
    : q.options.reduce((h, o) => h + 42 + (wrappedLines(o, inner - 40, 14.5) - 1) * 22, 0);
  return Math.ceil(100 + prompt + body);
}

function noteHeight(n) {
  return Math.ceil(60 + wrappedLines(n.text, n.width - 32, 15) * 24);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function hits(r, placed) {
  return placed.filter(p => overlaps(r, p));
}

// 往右 / 往下推到不跟已放好的東西重疊：每推一次至少越過一個元素，元素有限，一定會停
function pushRight(r, placed, gap) {
  for (let i = 0; i < LAYOUT_GUARD; i++) {
    const h = hits(r, placed);
    if (!h.length) return;
    r.x = Math.max(...h.map(p => p.x + p.w)) + gap;
  }
}

function pushDown(r, placed, gap) {
  for (let i = 0; i < LAYOUT_GUARD; i++) {
    const h = hits(r, placed);
    if (!h.length) return;
    r.y = Math.max(...h.map(p => p.y + p.h)) + gap;
  }
}

/**
 * x / y 有缺的自動排版；已給座標的不動。自動放的元素不會蓋到已經有座標的元素（例如 artifact_get 拿回去、
 * 每個元素都帶著座標的 canvas，再加一個沒有座標的 frame / 題目 / 說明卡）：
 * - frames：由左到右排成一列（y = 0），遇到東西就往右推
 * - questions：frames 右側一欄，由上往下疊，遇到東西就往下推
 * - notes：frames 下方，在 frames 的寬度範圍內由左到右排、排不下換行，遇到東西就往右推
 */
function layoutCanvas(frames, questions, notes) {
  const qH = new Map(questions.map(q => [q, questionHeight(q)]));
  const nH = new Map(notes.map(n => [n, noteHeight(n)]));
  const frameRect = (f, x, y) => ({ x, y: y - FRAME_TITLE_H, w: f.width, h: f.height + FRAME_TITLE_H });

  // 座標都給了的先佔位
  const placed = [];
  for (const f of frames) if (f.x !== null && f.y !== null) placed.push(frameRect(f, f.x, f.y));
  for (const q of questions) if (q.x !== null && q.y !== null) placed.push({ x: q.x, y: q.y, w: q.width, h: qH.get(q) });
  for (const n of notes) if (n.x !== null && n.y !== null) placed.push({ x: n.x, y: n.y, w: n.width, h: nH.get(n) });

  let cursor = 0;
  for (const f of frames) {
    if (f.x === null || f.y === null) {
      const autoX = f.x === null;
      const r = frameRect(f, autoX ? cursor : f.x, f.y ?? 0);
      if (autoX) pushRight(r, placed, FRAME_GAP);
      else pushDown(r, placed, FRAME_GAP);
      f.x = r.x;
      f.y = r.y + FRAME_TITLE_H;
      placed.push(r);
    }
    cursor = Math.max(cursor, f.x + f.width + FRAME_GAP);
  }
  const right = Math.max(...frames.map(f => f.x + f.width));
  const left = Math.min(...frames.map(f => f.x));
  const top = Math.min(...frames.map(f => f.y));
  const bottom = Math.max(...frames.map(f => f.y + f.height));

  let qy = top;
  for (const q of questions) {
    if (q.x !== null && q.y !== null) continue;
    const h = qH.get(q);
    if (q.y === null) {
      const autoX = q.x === null;
      const r = { x: autoX ? right + COLUMN_GAP : q.x, y: autoX ? qy : top, w: q.width, h };
      pushDown(r, placed, QUESTION_GAP);
      q.x = r.x;
      q.y = r.y;
      placed.push(r);
      if (autoX) qy = r.y + h + QUESTION_GAP;
    } else {
      const r = { x: right + COLUMN_GAP, y: q.y, w: q.width, h };
      pushRight(r, placed, COLUMN_GAP);
      q.x = r.x;
      placed.push(r);
    }
  }

  const rowRight = Math.max(right, left + NOTE_W.def);
  let nx = left;
  let ny = bottom + COLUMN_GAP;
  let rowH = 0;
  for (const n of notes) {
    if (n.x !== null && n.y !== null) continue;
    const h = nH.get(n);
    if (n.x === null && n.y === null) {
      const r = { x: nx, y: ny, w: n.width, h };
      let ok = false;
      for (let i = 0; i < LAYOUT_GUARD; i++) {
        // 超出 frames 的寬度就換一列（一列至少放一張）
        if (r.x > left && r.x + r.w > rowRight) {
          ny += rowH + NOTE_GAP;
          rowH = 0;
          r.x = left;
          r.y = ny;
        }
        const hit = hits(r, placed);
        if (!hit.length) { ok = true; break; }
        r.x = Math.max(...hit.map(p => p.x + p.w)) + NOTE_GAP;
      }
      if (!ok) {
        // 保險：放到所有東西的下面
        r.x = left;
        r.y = Math.max(...placed.map(p => p.y + p.h)) + NOTE_GAP;
        ny = r.y;
        rowH = 0;
      }
      n.x = r.x;
      n.y = r.y;
      placed.push(r);
      nx = r.x + r.w + NOTE_GAP;
      rowH = Math.max(rowH, h);
    } else if (n.x === null) {
      const r = { x: left, y: n.y, w: n.width, h };
      pushRight(r, placed, NOTE_GAP);
      n.x = r.x;
      placed.push(r);
    } else {
      const r = { x: n.x, y: bottom + COLUMN_GAP, w: n.width, h };
      pushDown(r, placed, NOTE_GAP);
      n.y = r.y;
      placed.push(r);
    }
  }
}

// ---------- 使用者回覆 payload（§4）----------

export function emptyPayload() {
  return { message: '', comments: [], answers: {}, selected: [], stickies: [], data: null };
}

function normalizeRect(r) {
  if (!isObj(r)) return null;
  const vals = ['x', 'y', 'width', 'height'].map(k => r[k]);
  if (!vals.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const [x, y, width, height] = vals;
  return {
    x: Math.round(clampNum(x, -COORD_MAX, COORD_MAX)),
    y: Math.round(clampNum(y, -COORD_MAX, COORD_MAX)),
    width: Math.round(clampNum(width, 0, COORD_MAX)),
    height: Math.round(clampNum(height, 0, COORD_MAX)),
  };
}

// 被點到的元素資訊：只收字串並截斷，不 400（來自 bridge 自動擷取，不是使用者打的）
function normalizeTarget(t) {
  if (!isObj(t)) return null;
  const str = (v, max) => (typeof v === 'string' ? truncateChars(cleanLine(v), max) : '');
  const tag = str(t.tag, L.targetTag).toLowerCase();
  const id = str(t.id, L.targetId) || null;
  const classes = Array.isArray(t.classes)
    ? t.classes.map(c => str(c, L.targetClass)).filter(Boolean).slice(0, L.targetClasses)
    : [];
  const text = str(t.text, L.targetText);
  const selector = str(t.selector, L.targetSelector);
  const rect = normalizeRect(t.rect);
  if (!tag && !id && !classes.length && !text && !selector && !rect) return null;
  return { tag, id, classes, text, selector, rect };
}

function userText(v, field, max) {
  if (typeof v !== 'string') return '';
  const s = cleanBlock(v);
  if (charLen(s) > max) throw bad(`${field} 不能超過 ${max} 字（目前 ${charLen(s)} 字）`);
  return s;
}

/**
 * 草稿與提交共用的正規化。
 * - kind：'html' | 'canvas'；spec：該版本正規化後的 canvas spec（html 不用）
 * - forSubmit：true 時丟掉空白的留言與便利貼（草稿保留）
 * 版本換了而失效的東西（不存在的 frame / question）直接丟掉，不整包 400。
 */
export function normalizePayload(input, { kind, spec, forSubmit = false } = {}) {
  if (!isObj(input)) throw bad('payload 必須是物件');
  let raw;
  try { raw = JSON.stringify(input); } catch { throw bad('payload 無法序列化成 JSON'); }
  const size = bytesOf(raw);
  if (size > PAYLOAD_MAX_BYTES) throw tooLarge(`回覆內容超過 ${fmtBytes(PAYLOAD_MAX_BYTES)}（目前 ${fmtBytes(size)}）`);

  const isCanvas = kind === 'canvas';
  const frames = isCanvas && Array.isArray(spec?.frames) ? spec.frames : [];
  const frameIds = isCanvas ? new Set(frames.map(f => f.id)) : new Set([HTML_FRAME_ID]);
  const questions = isCanvas && Array.isArray(spec?.questions) ? spec.questions : [];

  const out = emptyPayload();
  out.message = userText(input.message, 'message', L.message);

  // comments
  if (Array.isArray(input.comments)) {
    if (input.comments.length > L.comments) throw bad(`留言最多 ${L.comments} 則（目前 ${input.comments.length} 則）`);
    const seen = new Set();
    input.comments.forEach((c, i) => {
      if (!isObj(c)) return;
      if (typeof c.id !== 'string' || !ELEMENT_ID_RE.test(c.id) || seen.has(c.id)) return;
      const frameId = isCanvas ? c.frame_id : HTML_FRAME_ID;
      if (typeof frameId !== 'string' || !frameIds.has(frameId)) return;
      const text = userText(c.text, `comments[${i}].text`, L.commentText);
      if (forSubmit && !text.trim()) return;
      seen.add(c.id);
      out.comments.push({
        id: c.id,
        frame_id: frameId,
        x: coord(c.x) ?? 0,
        y: coord(c.y) ?? 0,
        text,
        target: normalizeTarget(c.target),
      });
    });
  }

  // answers：只收 spec 裡存在的題目；single 必須是選項之一、multi 是子集合
  if (isObj(input.answers)) {
    for (const q of questions) {
      if (!Object.hasOwn(input.answers, q.id)) continue;
      const v = input.answers[q.id];
      if (q.type === 'single') {
        if (typeof v === 'string' && q.options.includes(v)) out.answers[q.id] = v;
      } else if (q.type === 'multi') {
        if (!Array.isArray(v)) continue;
        const picked = [...new Set(v.filter(x => typeof x === 'string' && q.options.includes(x)))];
        if (picked.length) out.answers[q.id] = picked;
      } else {
        const s = userText(v, `answers.${q.id}`, L.answerText);
        if (s.trim()) out.answers[q.id] = s;
      }
    }
  }

  if (isCanvas && Array.isArray(input.selected)) {
    out.selected = [...new Set(input.selected.filter(x => typeof x === 'string' && frameIds.has(x)))];
  }

  if (isCanvas && Array.isArray(input.stickies)) {
    if (input.stickies.length > L.stickies) throw bad(`便利貼最多 ${L.stickies} 張（目前 ${input.stickies.length} 張）`);
    const seen = new Set();
    input.stickies.forEach((s, i) => {
      if (!isObj(s)) return;
      if (typeof s.id !== 'string' || !ELEMENT_ID_RE.test(s.id) || seen.has(s.id)) return;
      const text = userText(s.text, `stickies[${i}].text`, L.stickyText);
      if (forSubmit && !text.trim()) return;
      seen.add(s.id);
      out.stickies.push({
        id: s.id,
        text,
        x: coord(s.x) ?? 0,
        y: coord(s.y) ?? 0,
        color: CARD_COLOR_SET.has(s.color) ? s.color : 'yellow',
      });
    });
  }

  if (input.data !== undefined && input.data !== null) {
    const json = JSON.stringify(input.data);
    if (json !== undefined) {
      const n = bytesOf(json);
      if (n > DATA_MAX_BYTES) throw tooLarge(`data 超過 ${fmtBytes(DATA_MAX_BYTES)}（目前 ${fmtBytes(n)}）`);
      out.data = JSON.parse(json);
    }
  }
  return out;
}

export function isEmptyPayload(p) {
  return !p.message.trim()
    && p.comments.length === 0
    && Object.keys(p.answers).length === 0
    && p.selected.length === 0
    && p.stickies.length === 0
    && p.data === null;
}

// 提交紀錄列表用的數量摘要
export function payloadCounts(p) {
  const x = isObj(p) ? p : {};
  return {
    comments: Array.isArray(x.comments) ? x.comments.length : 0,
    answers: isObj(x.answers) ? Object.keys(x.answers).length : 0,
    selected: Array.isArray(x.selected) ? x.selected.length : 0,
    stickies: Array.isArray(x.stickies) ? x.stickies.length : 0,
    has_data: x.data !== undefined && x.data !== null,
    has_message: typeof x.message === 'string' && x.message.trim() !== '',
  };
}

// ---------- 給 Claude 讀的摘要（§7.3）----------

function fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function oneLine(s) {
  return String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

// 多行文字接在清單項目後面：第二行起縮排兩格，維持在同一個 list item 裡
function indentRest(s) {
  return String(s ?? '').trim().replace(/\n/g, '\n  ');
}

function targetSummary(t) {
  if (!isObj(t)) return '';
  let sel = t.tag || '';
  if (t.id) sel += `#${t.id}`;
  if (Array.isArray(t.classes) && t.classes.length) sel += '.' + t.classes.slice(0, 3).join('.');
  let s = sel ? `<${sel}>` : '';
  if (t.text) s += `「${t.text}」`;
  return s;
}

function fenceFor(text) {
  let n = 3;
  const runs = String(text).match(/`+/g) || [];
  for (const r of runs) if (r.length >= n) n = r.length + 1;
  return '`'.repeat(n);
}

function truncateBytes(s, max) {
  if (bytesOf(s) <= max) return { text: s, cut: false };
  const buf = Buffer.from(s, 'utf8').subarray(0, max);
  return { text: buf.toString('utf8').replace(/�+$/, ''), cut: true };
}

function distToRect(px, py, f) {
  const dx = Math.max(f.x - px, 0, px - (f.x + f.width));
  const dy = Math.max(f.y - py, 0, py - (f.y + f.height));
  return Math.hypot(dx, dy);
}

/**
 * 把一次提交整理成繁中 Markdown。空的區塊不輸出。
 * artifact：meta；spec：該版本的 canvas spec（html kind 給 null）；submission：{ seq, version, created_at, payload }
 * dataHint：資料超過 4 KiB 被截斷時，告訴讀的人完整內容在哪（呼叫端知道 JSON 有沒有完整附上）
 */
export function summarizeSubmission({ artifact, spec, submission, dataHint = '完整內容見下方 JSON 的 payload.data' }) {
  const p = isObj(submission?.payload) ? submission.payload : emptyPayload();
  const isCanvas = artifact?.kind === 'canvas';
  const frames = isCanvas && Array.isArray(spec?.frames) ? spec.frames : [];
  const frameById = new Map(frames.map(f => [f.id, f]));
  const frameName = (id) => {
    const f = frameById.get(id);
    return f && f.title && f.title !== id ? f.title : null;
  };

  const lines = [`## 提交 #${submission?.seq ?? '?'}（v${submission?.version ?? '?'}，${fmtLocal(submission?.created_at)}）`];

  const msg = typeof p.message === 'string' ? p.message.trim() : '';
  if (msg) {
    lines.push(msg.includes('\n')
      ? `**給 Claude 的話**：\n${msg.split('\n').map(l => `> ${l}`).join('\n')}`
      : `**給 Claude 的話**：${msg}`);
  }

  const selected = Array.isArray(p.selected) ? p.selected : [];
  if (selected.length) {
    lines.push(`**選這個**：${selected.map(id => (frameName(id) ? `${frameName(id)}（${id}）` : id)).join('、')}`);
  }

  const answers = isObj(p.answers) ? p.answers : {};
  const qs = isCanvas && Array.isArray(spec?.questions) ? spec.questions : [];
  const answered = qs.filter(q => Object.hasOwn(answers, q.id));
  if (answered.length) {
    lines.push('**問答**');
    for (const q of answered) {
      const v = answers[q.id];
      const a = Array.isArray(v) ? v.join('、') : indentRest(v);
      lines.push(`- ${oneLine(q.prompt)} → ${a}`);
    }
  }

  const comments = Array.isArray(p.comments) ? p.comments : [];
  if (comments.length) {
    lines.push('**留言**');
    for (const c of comments) {
      const parts = [];
      if (isCanvas) {
        const name = frameName(c.frame_id);
        parts.push(name ? `[${name} / ${c.frame_id}]` : `[${c.frame_id}]`);
      }
      const t = targetSummary(c.target);
      if (t) parts.push(t);
      parts.push(`@ (${Math.round(Number(c.x) || 0)}, ${Math.round(Number(c.y) || 0)})`);
      lines.push(`- ${parts.join(' ')}：${indentRest(c.text) || '（沒有文字）'}`);
    }
  }

  const stickies = Array.isArray(p.stickies) ? p.stickies : [];
  if (stickies.length) {
    lines.push('**便利貼**');
    for (const s of stickies) {
      let near = null;
      let best = Infinity;
      for (const f of frames) {
        const d = distToRect(Number(s.x) || 0, Number(s.y) || 0, f);
        if (d < best) { best = d; near = f; }
      }
      const where = near ? `（靠近 ${near.title || near.id}）` : `（${Math.round(Number(s.x) || 0)}, ${Math.round(Number(s.y) || 0)}）`;
      lines.push(`- ${where}：${indentRest(s.text)}`);
    }
  }

  if (p.data !== undefined && p.data !== null) {
    const json = JSON.stringify(p.data, null, 2) ?? 'null';
    const { text, cut } = truncateBytes(json, 4 * KiB);
    const body = cut ? `${text}\n…（超過 4 KiB，已截斷${dataHint ? `；${dataHint}` : ''}）` : text;
    const fence = fenceFor(body);
    lines.push('**資料**（window.codd.submit）', `${fence}json`, body, fence);
  }

  return lines.join('\n');
}

// ---------- Repo ----------

const META_COLUMNS = `
  a.id, a.kind, a.title, a.current_version, a.origin_terminal_id, a.origin_label, a.created_at, a.updated_at,
  (SELECT COUNT(*) FROM artifact_submissions s WHERE s.artifact_id = a.id) AS submission_count,
  (SELECT COUNT(*) FROM artifact_submissions s WHERE s.artifact_id = a.id AND s.read_at IS NULL) AS unread_count,
  (SELECT MAX(s.created_at) FROM artifact_submissions s WHERE s.artifact_id = a.id) AS last_submission_at`;

const SUBMISSION_COLUMNS = 'id, seq, version, payload, notify_status, created_at, read_at';
const SPEC_CACHE_MAX = 16;

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function toSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    version: row.version,
    payload: parseJson(row.payload, emptyPayload()),
    notify_status: row.notify_status,
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

export class ArtifactRepo {
  constructor(db, { maxContentBytes } = {}) {
    if (!db) throw new Error('ArtifactRepo: db is required');
    this.db = db;
    this.maxContentBytes = clampMaxBytes(maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES);
    // 版本內容不會變：解析過的 canvas spec 放小快取，frame 路由一頁會連打好幾次
    this._specCache = new Map();
    const p = (sql) => db.prepare(sql);
    this.q = {
      exists: p('SELECT 1 FROM artifacts WHERE id = ?'),
      row: p('SELECT id, kind, title, current_version FROM artifacts WHERE id = ? AND deleted_at IS NULL'),
      meta: p(`SELECT ${META_COLUMNS} FROM artifacts a WHERE a.id = ? AND a.deleted_at IS NULL`),
      listAll: p(`SELECT ${META_COLUMNS} FROM artifacts a WHERE a.deleted_at IS NULL
                  ORDER BY a.updated_at DESC, a.rowid DESC LIMIT ?`),
      listByOrigin: p(`SELECT ${META_COLUMNS} FROM artifacts a WHERE a.deleted_at IS NULL AND a.origin_terminal_id = ?
                  ORDER BY a.updated_at DESC, a.rowid DESC LIMIT ?`),
      insertArtifact: p(`INSERT INTO artifacts (id, kind, title, current_version, origin_terminal_id, origin_label, created_at, updated_at)
                  VALUES (?, ?, ?, 1, ?, ?, ?, ?)`),
      insertVersion: p('INSERT INTO artifact_versions (artifact_id, version, content, note, created_at) VALUES (?, ?, ?, ?, ?)'),
      bumpVersion: p('UPDATE artifacts SET current_version = ?, title = ?, updated_at = ? WHERE id = ?'),
      setTitle: p('UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'),
      softDelete: p('UPDATE artifacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'),
      version: p('SELECT version, content, note, created_at FROM artifact_versions WHERE artifact_id = ? AND version = ?'),
      versions: p(`SELECT version, note, created_at, length(CAST(content AS BLOB)) AS bytes
                  FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`),
      getDraft: p('SELECT version, payload, updated_at FROM artifact_drafts WHERE artifact_id = ? AND version = ?'),
      saveDraft: p(`INSERT INTO artifact_drafts (artifact_id, version, payload, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT (artifact_id, version) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`),
      clearDraft: p('DELETE FROM artifact_drafts WHERE artifact_id = ? AND version = ?'),
      nextSeq: p('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM artifact_submissions WHERE artifact_id = ?'),
      insertSubmission: p(`INSERT INTO artifact_submissions (artifact_id, seq, version, payload, notify_status, created_at)
                  VALUES (?, ?, ?, ?, 'none', ?)`),
      submissionById: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE id = ?`),
      submissionBySeq: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE artifact_id = ? AND seq = ?`),
      setOrigin: p('UPDATE artifacts SET origin_terminal_id = ?, origin_label = ? WHERE id = ? AND deleted_at IS NULL'),
      setNotify: p('UPDATE artifact_submissions SET notify_status = ? WHERE id = ?'),
      expirePending: p("UPDATE artifact_submissions SET notify_status = 'no_session' WHERE notify_status = 'pending'"),
      markRead: p('UPDATE artifact_submissions SET read_at = ? WHERE artifact_id = ? AND seq = ? AND read_at IS NULL'),
      subsAsc: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE artifact_id = ? AND seq > ?
                  ORDER BY seq ASC LIMIT ?`),
      subsAscUnread: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE artifact_id = ? AND seq > ? AND read_at IS NULL
                  ORDER BY seq ASC LIMIT ?`),
      subsDesc: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE artifact_id = ? AND seq > ?
                  ORDER BY seq DESC LIMIT ?`),
      subsDescUnread: p(`SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE artifact_id = ? AND seq > ? AND read_at IS NULL
                  ORDER BY seq DESC LIMIT ?`),
    };
  }

  // 依 kind 驗證內容 → 存進 artifact_versions.content 的字串
  _content(kind, { html, canvas }) {
    if (kind === 'html') {
      if (html === undefined || html === null) throw bad('kind="html" 需要 html 欄位（完整的 HTML 字串）');
      if (typeof html !== 'string') throw bad('html 必須是字串');
      if (!html.trim()) throw bad('html 不能是空的');
      const n = bytesOf(html);
      if (n > this.maxContentBytes) throw tooLarge(`html 超過 ${fmtBytes(this.maxContentBytes)}（目前 ${fmtBytes(n)}）`);
      return html;
    }
    if (canvas === undefined || canvas === null) throw bad('kind="canvas" 需要 canvas 欄位（含 frames 的物件）');
    return JSON.stringify(normalizeCanvasSpec(canvas, { maxContentBytes: this.maxContentBytes }));
  }

  _versionNote(note) {
    if (note === undefined || note === null) return null;
    if (typeof note !== 'string') throw bad('note 必須是字串');
    const s = cleanBlock(note).trim();
    if (!s) return null;
    if (charLen(s) > L.versionNote) throw bad(`note 不能超過 ${L.versionNote} 字`);
    return s;
  }

  create({ kind, title, html, canvas, note, originTerminalId = null, originLabel = null } = {}) {
    if (!KINDS.has(kind)) throw bad('kind 必須是 "html" 或 "canvas"');
    const t = normalizeTitle(title);
    const content = this._content(kind, { html, canvas });
    const n = this._versionNote(note);
    const origin = typeof originTerminalId === 'string' && originTerminalId && originTerminalId.length <= 64
      ? originTerminalId : null;
    const label = typeof originLabel === 'string' ? truncateChars(cleanLine(originLabel), L.originLabel) || null : null;
    const now = nowIso();
    let id = newArtifactId();
    this.db.transaction(() => {
      for (let i = 0; i < 8 && this.q.exists.get(id); i++) id = newArtifactId();
      this.q.insertArtifact.run(id, kind, t, origin, label, now, now);
      this.q.insertVersion.run(id, 1, content, n, now);
    })();
    return this.get(id);
  }

  update(id, { title, html, canvas, note } = {}) {
    const row = this.q.row.get(String(id ?? ''));
    if (!row) throw httpError(404, `找不到 artifact「${id}」（可能已刪除）`);
    const hasHtml = html !== undefined && html !== null;
    const hasCanvas = canvas !== undefined && canvas !== null;
    const hasTitle = title !== undefined && title !== null;
    if (row.kind === 'html' && hasCanvas) {
      throw bad('這個 artifact 是 kind="html"，kind 不能改；要畫布請另外 artifact_create 一個 canvas');
    }
    if (row.kind === 'canvas' && hasHtml) {
      throw bad('這個 artifact 是 kind="canvas"，請用 canvas 欄位更新（kind 不能改）');
    }
    if (!hasTitle && !hasHtml && !hasCanvas) throw bad('沒有要更新的內容：請提供 title、html 或 canvas');
    const t = hasTitle ? normalizeTitle(title) : null;
    const content = hasHtml || hasCanvas ? this._content(row.kind, { html, canvas }) : null;
    // note 只跟著新版本存；只改 title 時忽略
    const n = content !== null ? this._versionNote(note) : null;
    const now = nowIso();
    this.db.transaction(() => {
      const cur = this.q.row.get(row.id);
      if (!cur) throw httpError(404, `找不到 artifact「${id}」（可能已刪除）`);
      if (content !== null) {
        const v = cur.current_version + 1;
        this.q.insertVersion.run(cur.id, v, content, n, now);
        this.q.bumpVersion.run(v, t ?? cur.title, now, cur.id);
      } else {
        this.q.setTitle.run(t, now, cur.id);
      }
    })();
    return this.get(row.id);
  }

  getMeta(id) {
    if (typeof id !== 'string' || !id) return null;
    return this.q.meta.get(id) ?? null;
  }

  // → { ...meta, version, note, version_created_at, content } | null（artifact 或版本不存在、已刪除都回 null）
  get(id, { version } = {}) {
    const meta = this.getMeta(id);
    if (!meta) return null;
    const v = version === undefined || version === null || version === '' ? meta.current_version : toVersion(version);
    if (!v) return null;
    const row = this.q.version.get(meta.id, v);
    if (!row) return null;
    const content = meta.kind === 'html'
      ? { html: row.content }
      : { canvas: parseJson(row.content, { frames: [], questions: [], notes: [] }) };
    return { ...meta, version: v, note: row.note, version_created_at: row.created_at, content };
  }

  // 解析過的 canvas spec（快取；呼叫端不要改它）。html kind 或不存在 → null
  _spec(id, version) {
    const key = `${id}:${version}`;
    if (this._specCache.has(key)) return this._specCache.get(key);
    const row = this.q.version.get(id, version);
    if (!row) return null;
    const spec = parseJson(row.content, null);
    if (!isObj(spec)) return null;
    this._specCache.set(key, spec);
    if (this._specCache.size > SPEC_CACHE_MAX) this._specCache.delete(this._specCache.keys().next().value);
    return spec;
  }

  // 給 frame 路由：某版本某個 frame 的原始 HTML；不存在 → null
  getFrameHtml(id, version, frameId) {
    const meta = this.getMeta(id);
    const v = toVersion(version);
    if (!meta || !v || typeof frameId !== 'string') return null;
    if (meta.kind === 'html') {
      if (frameId !== HTML_FRAME_ID) return null;
      return this.q.version.get(meta.id, v)?.content ?? null;
    }
    const spec = this._spec(meta.id, v);
    const frame = spec?.frames?.find(f => f.id === frameId);
    return frame ? frame.html : null;
  }

  // 該版本的 canvas spec（html kind → null；呼叫端不要改它）
  getSpec(id, version) {
    const meta = this.getMeta(id);
    const v = toVersion(version);
    if (!meta || !v || meta.kind !== 'canvas') return null;
    return this._spec(meta.id, v);
  }

  list({ limit = 50, originTerminalId } = {}) {
    const lim = clampInt(limit, 1, 200, 50);
    if (typeof originTerminalId === 'string' && originTerminalId) {
      return this.q.listByOrigin.all(originTerminalId, lim);
    }
    return this.q.listAll.all(lim);
  }

  versions(id) {
    if (!this.getMeta(id)) return [];
    return this.q.versions.all(id);
  }

  remove(id) {
    if (typeof id !== 'string' || !id) return false;
    const now = nowIso();
    return this.q.softDelete.run(now, now, id).changes > 0;
  }

  // → meta | null
  rename(id, title) {
    const t = normalizeTitle(title);
    if (typeof id !== 'string' || !id) return null;
    const r = this.q.setTitle.run(t, nowIso(), id);
    return r.changes > 0 ? this.getMeta(id) : null;
  }

  // 該版本存在（且 artifact 沒被刪）→ { meta, version, spec }，否則 404
  _versionCtx(id, version) {
    const meta = this.getMeta(id);
    if (!meta) throw httpError(404, `找不到 artifact「${id}」（可能已刪除）`);
    const v = toVersion(version);
    if (!v) throw bad('version 必須是正整數');
    if (!this.q.version.get(meta.id, v)) throw httpError(404, `artifact「${id}」沒有 v${v}`);
    const spec = meta.kind === 'canvas' ? this._spec(meta.id, v) : null;
    return { meta, version: v, spec };
  }

  // → { version, payload, updated_at } | null
  getDraft(id, version) {
    if (!this.getMeta(id)) return null;
    const v = toVersion(version);
    if (!v) return null;
    const row = this.q.getDraft.get(id, v);
    if (!row) return null;
    return { version: row.version, payload: parseJson(row.payload, emptyPayload()), updated_at: row.updated_at };
  }

  // 草稿的併發檢查：base = 呼叫端上次看到的 draft updated_at（沒有草稿時是 null）；undefined = 不檢查（舊呼叫端）。
  // 跟目前存的不一樣 = 別的分頁 / 裝置改過，或草稿已經被提交清掉 → 409，呼叫端要重新載入
  _checkDraftBase(row, base) {
    if (base === undefined) return;
    const stored = row?.updated_at ?? null;
    const b = typeof base === 'string' && base ? base : null;
    if (stored === b) return;
    const e = httpError(409, stored
      ? '這份回覆在別的分頁或裝置改過了，請重新載入後再繼續'
      : '這份回覆已經在別的分頁或裝置提交（或清掉）了，請重新載入後再繼續');
    e.code = 'draft_conflict';
    e.extra = { code: 'draft_conflict', draft_updated_at: stored };
    throw e;
  }

  // → { updated_at, payload }（payload 是正規化後的）。opts.base：見 _checkDraftBase
  saveDraft(id, version, payload, { base } = {}) {
    const ctx = this._versionCtx(id, version);
    const p = normalizePayload(payload, { kind: ctx.meta.kind, spec: ctx.spec });
    const json = JSON.stringify(p);
    const now = this.db.transaction(() => {
      const row = this.q.getDraft.get(ctx.meta.id, ctx.version);
      this._checkDraftBase(row, base);
      // updated_at 兼任版本標記：一定比上一次大（同一毫秒內存兩次也分得出來）
      const stamp = nextStamp(row?.updated_at);
      this.q.saveDraft.run(ctx.meta.id, ctx.version, json, stamp);
      return stamp;
    })();
    return { updated_at: now, payload: p };
  }

  clearDraft(id, version) {
    const v = toVersion(version);
    if (typeof id !== 'string' || !v) return false;
    return this.q.clearDraft.run(id, v).changes > 0;
  }

  // 正規化、seq = max + 1、清掉該版本草稿 → submission。version 不是最新 → 409。
  // draftBase：同 saveDraft 的 base（undefined = 不檢查）；草稿在別處改過或已被提交 → 409，避免重複提交舊內容
  addSubmission(id, { version, payload, draftBase } = {}) {
    const ctx = this._versionCtx(id, version);
    if (ctx.version !== ctx.meta.current_version) {
      throw httpError(409, `已有新版本 v${ctx.meta.current_version}，請切到最新版本後再提交`);
    }
    const p = normalizePayload(payload, { kind: ctx.meta.kind, spec: ctx.spec, forSubmit: true });
    if (isEmptyPayload(p)) {
      throw bad('沒有可以提交的內容（留言、作答、選擇、便利貼、資料或給 Claude 的話至少要有一項）');
    }
    const now = nowIso();
    const rowId = this.db.transaction(() => {
      const cur = this.q.row.get(ctx.meta.id);
      if (!cur) throw httpError(404, `找不到 artifact「${id}」（可能已刪除）`);
      if (cur.current_version !== ctx.version) {
        throw httpError(409, `已有新版本 v${cur.current_version}，請切到最新版本後再提交`);
      }
      this._checkDraftBase(this.q.getDraft.get(cur.id, ctx.version), draftBase);
      const seq = this.q.nextSeq.get(cur.id).seq;
      const r = this.q.insertSubmission.run(cur.id, seq, ctx.version, JSON.stringify(p), now);
      this.q.clearDraft.run(cur.id, ctx.version);
      return r.lastInsertRowid;
    })();
    return toSubmission(this.q.submissionById.get(rowId));
  }

  getSubmission(submissionId) {
    return toSubmission(this.q.submissionById.get(submissionId));
  }

  // 某個 artifact 的第 seq 次提交；artifact 不存在（或已刪除）/ 沒有這次提交 → null
  getSubmissionBySeq(id, seq) {
    if (!this.getMeta(id)) return null;
    const n = toVersion(seq);
    if (!n) return null;
    return toSubmission(this.q.submissionBySeq.get(id, n));
  }

  // 把 artifact 交給另一個 session（之後由它更新、收通知）。→ meta | null
  setOrigin(id, terminalId, label = null) {
    if (typeof id !== 'string' || !id) return null;
    const origin = typeof terminalId === 'string' && terminalId && terminalId.length <= 64 ? terminalId : null;
    const l = typeof label === 'string' ? truncateChars(cleanLine(label), L.originLabel) || null : null;
    const r = this.q.setOrigin.run(origin, l, id);
    return r.changes > 0 ? this.getMeta(id) : null;
  }

  setNotifyStatus(submissionId, status) {
    if (!NOTIFY_STATUS_SET.has(status)) throw new Error(`invalid notify status: ${status}`);
    return this.q.setNotify.run(status, submissionId).changes > 0;
  }

  // server 重啟時 PTY 都已結束：上次留下的 pending 不可能再送出
  expireStalePending() {
    return this.q.expirePending.run().changes;
  }

  // seq ASC（order: 'desc' 給提交紀錄列表用）
  listSubmissions(id, { sinceSeq = 0, unreadOnly = false, limit = 20, order = 'asc' } = {}) {
    if (!this.getMeta(id)) return [];
    const since = clampInt(sinceSeq, 0, Number.MAX_SAFE_INTEGER, 0);
    const lim = clampInt(limit, 1, 500, 20);
    const stmt = order === 'desc'
      ? (unreadOnly ? this.q.subsDescUnread : this.q.subsDesc)
      : (unreadOnly ? this.q.subsAscUnread : this.q.subsAsc);
    return stmt.all(id, since, lim).map(toSubmission);
  }

  // seqs: number[] → 實際標記的筆數（已讀過的不覆蓋 read_at）
  markRead(id, seqs) {
    if (typeof id !== 'string' || !Array.isArray(seqs) || !seqs.length) return 0;
    const list = [...new Set(seqs.map(Number).filter(n => Number.isInteger(n) && n >= 1))];
    if (!list.length) return 0;
    const now = nowIso();
    return this.db.transaction(() => {
      let n = 0;
      for (const seq of list) n += this.q.markRead.run(now, id, seq).changes;
      return n;
    })();
  }
}
