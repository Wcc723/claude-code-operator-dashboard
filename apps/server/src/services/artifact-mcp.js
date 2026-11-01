import { realpath, open as openFile } from 'node:fs/promises';
import { resolve as resolvePath, isAbsolute, relative, sep } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  summarizeSubmission, isEmptyPayload, payloadCounts, FRAME_HTML_MAX_BYTES, HTML_FRAME_ID,
} from './artifact-repo.js';

// CODD artifact 的 MCP 工具（給 CODD 開的 Claude Code session 用，經 routes/mcp.js 以 HTTP 提供）。
// 每個 HTTP 請求建一個新的 Server（stateless）；identity 是 bearer token 對應的 { terminalId }，
// token 本身不會傳進這裡，所以工具的回應與錯誤訊息裡不可能出現 token。
// 權限：讀（artifact_get / artifact_list / 只看不標已讀的 artifact_read_submissions）不限；
// 改（artifact_update、把提交標成已讀）只限建立它的 session（含 restart 後接手的那個）。
// host token 只能改 host token 建立的（origin 是 NULL 的）artifact。

export const SERVER_INFO = { name: 'codd-artifacts', version: '0.1.0' };

export const INSTRUCTIONS = '這是 CODD 的 artifact 服務。需要給使用者看 HTML 頁面、設計稿或要他做選擇時，用 artifact_create 發布到 CODD'
  + '（使用者從手機或其他電腦開 CODD 就看得到，不受 Claude 帳號切換影響），優先於內建的 Artifact 工具'
  + '（mcp__claude-artifacts__* 的 publish_version、publish_files、create_from_type、list_types 等：那些發到 claude.ai、跟著 Claude 帳號走，切換帳號後使用者會打不開）。'
  + '使用者要看設計稿、比較方案時也用 artifact_create，不必先呼叫 list_types；只有使用者明確要發到 claude.ai 時才用那些工具。'
  + 'kind="html" 是單一頁面；kind="canvas" 是設計畫布，可放多個 frame、問答卡與說明卡。HTML 必須自成一體：CSS/JS 內嵌或從 https CDN 載入，不能 fetch 網路資料，也不能引用相對路徑資源。'
  + '已經寫成檔案的頁面可以用 html_path（這個 session 工作目錄底下的 .html 檔）代替 html，不必把整份 HTML 再打一次。'
  + '發布後把回傳的 url 告訴使用者。使用者按「提交」後，對話中會出現一行 [CODD] 通知，這時呼叫 artifact_read_submissions 讀取回饋；修改後用 artifact_update 發新版本，不要另開新的 artifact。';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ELEMENT_ID_PATTERN = '^[A-Za-z0-9_-]{1,40}$';
const ELEMENT_ID_RE = new RegExp(ELEMENT_ID_PATTERN);
const NOTE_MAX = 4000;
const TITLE_INPUT_MAX = 1000; // 真正的上限（120 字）由 repo 驗證；這裡只擋離譜的輸入
const LABEL_MAX = 120;
const LIST_DEFAULT = 20, LIST_MAX = 100;
const SUBMISSIONS_BATCH = 20;
// artifact_read_submissions 一次回傳的文字預算（字元）：Claude Code 對 MCP 工具輸出有 token 上限，
// 超過就分批，沒讀到的維持未讀、下次再讀；單一提交本身就超過的，改用 seq + offset 分段讀
const READ_TEXT_BUDGET = 40000;
const SUMMARY_MAX = 20000;
const CHUNK_MIN = 4000;
// artifact_get 預設直接附上 HTML 的總量上限（bytes）；超過就只給 frame 的 metadata，要原文用 frame_id / include_html
const INLINE_HTML_MAX = 40 * 1024;
const PATH_INPUT_MAX = 4096;
const HTML_EXT_RE = /\.html?$/i;
const PASS_THROUGH_STATUS = new Set([400, 403, 404, 409, 413, 422]);
// C0 / C1 控制字元與 U+2028/2029（顯示用字串一律移除）
const CONTROL_RE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{2028}\u{2029}]/gu;

// ── 工具定義 ───────────────────────────────────────────────

const ELEMENT_ID_SCHEMA = (prefix) => ({
  type: 'string',
  pattern: ELEMENT_ID_PATTERN,
  description: `元素 id（英數、_、-，1–40 字）。省略時自動產生（${prefix}1、${prefix}2…）。frames / questions / notes 之間不得重複。改版時沿用同一個 id，使用者的留言與作答才對得上。`,
});

const HTML_PATH_DESC = '已經存在的 .html / .htm 檔路徑（這個 session 工作目錄底下；相對路徑以工作目錄為準）。跟 html 二擇一，'
  + '適合頁面已經寫成檔案時，不必把整份 HTML 再打一次。只有 CODD 開的 session 能用。';

function frameItemSchema({ forUpdate }) {
  return {
    type: 'object',
    properties: {
      id: { ...ELEMENT_ID_SCHEMA('f'), description: ELEMENT_ID_SCHEMA('f').description + '不能用 main。' },
      title: { type: 'string', maxLength: 120, description: 'frame 標題（顯示在 frame 上方，例如「首頁 A：大圖版」）' },
      html: {
        type: 'string',
        minLength: 1,
        description: forUpdate
          ? '完整的 HTML 文件。省略（也不給 html_path）時沿用目前版本同 id 的 frame：沒改的 frame 只要給 id，不必重寫 HTML。'
          : '完整的 HTML 文件（CSS / JS 內嵌或從 https CDN 載入；不能連網抓資料、不能用相對路徑資源）。html 與 html_path 一定要給一個。',
      },
      html_path: { type: 'string', maxLength: PATH_INPUT_MAX, description: HTML_PATH_DESC },
      width: { type: 'number', minimum: 120, maximum: 4000, description: '寬（px），預設 1280' },
      height: { type: 'number', minimum: 120, maximum: 4000, description: '高（px），預設 800；內容超過時 frame 內可捲動' },
      x: { type: 'number', description: '畫布 x 座標（選填）' },
      y: { type: 'number', description: '畫布 y 座標（選填）' },
    },
  };
}

function canvasSchema({ forUpdate }) {
  return {
    type: 'object',
    description: (forUpdate
      ? 'canvas artifact 的新內容（整個 canvas，格式同 artifact_create）。frames 的順序與清單以這次給的為準；'
        + '只給 id、不給 html 的 frame 沿用目前版本同 id 的 frame（HTML，以及沒給的 title / 尺寸 / 座標），所以只改題目或其中一個 frame 時，其他 frame 只要給 id。'
      : 'kind="canvas" 時必填。設計畫布：frames（設計稿，1–24 個，必填）、questions（問答卡，0–30 個）、notes（說明卡，0–30 個）。')
      + 'x / y 是畫布座標（px），省略就自動排版（不會蓋到已有座標的元素）：frames 由左到右排成一列、questions 疊在 frames 右側、notes 排在 frames 下方。'
      + '整個 canvas 的 JSON 預設上限 3 MiB，單一 frame 的 html ≤ 1.5 MiB。',
    required: ['frames'],
    properties: {
      frames: {
        type: 'array',
        minItems: 1,
        maxItems: 24,
        description: '設計稿。每個 frame 是一份獨立、自成一體的 HTML 文件，在 sandbox iframe 裡以 width × height 顯示，使用者可以在上面釘選留言、標「選這個」。'
          + '建議尺寸：手機 390×844、桌機 1440×900。要讓使用者比較方案時，一個方案一個 frame。',
        items: frameItemSchema({ forUpdate }),
      },
      questions: {
        type: 'array',
        maxItems: 30,
        description: '問答卡：要使用者做的選擇或回答。single = 單選、multi = 複選（options 2–12 個，每個 ≤ 200 字）、text = 自由填寫（不需要 options）。',
        items: {
          type: 'object',
          required: ['prompt', 'type'],
          properties: {
            id: ELEMENT_ID_SCHEMA('q'),
            prompt: { type: 'string', maxLength: 1000, description: '題目' },
            type: { type: 'string', enum: ['single', 'multi', 'text'] },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 12,
              items: { type: 'string', maxLength: 200 },
              description: 'single / multi 的選項',
            },
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number', description: '卡片寬（px），預設 320' },
          },
        },
      },
      notes: {
        type: 'array',
        maxItems: 30,
        description: '說明卡（唯讀）：寫給使用者看的說明，例如各方案的差異、設計理由。保留換行。',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            id: ELEMENT_ID_SCHEMA('n'),
            text: { type: 'string', maxLength: 4000 },
            color: { type: 'string', enum: ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'], description: '底色，預設 yellow' },
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number', description: '卡片寬（px）' },
          },
        },
      },
    },
  };
}

const HTML_SCHEMA = {
  type: 'string',
  minLength: 1,
  description: 'kind="html" 時 html 或 html_path 必填一個：完整的 HTML 文件（預設上限 3 MiB）。在 sandbox iframe 裡執行：CSS / JS 內嵌或從 https CDN 載入；'
    + '不能 fetch / XHR / WebSocket 連網，不能用相對路徑資源，也不能用 cookie / localStorage。'
    + '頁面可以呼叫 window.codd.submit(data) 把任意 JSON（≤ 256 KiB）放進使用者的回覆並打開提交視窗，適合表單或互動選擇。',
};

const ARTIFACT_ID_SCHEMA = { type: 'string', description: 'artifact id（artifact_create 回傳的 id；也可以直接給 url）' };

export const TOOLS = [
  {
    name: 'artifact_create',
    title: '發布 artifact 到 CODD',
    description: '在 CODD 發布新的 artifact，回傳 { id, kind, title, version, url }；發布後把 url 告訴使用者。'
      + '優先於內建的 Artifact 工具（mcp__claude-artifacts__*，發到 claude.ai、切換 Claude 帳號後使用者會打不開）：'
      + 'CODD 的 artifact 不受 Claude 帳號切換影響，使用者從手機或其他電腦登入 CODD 就能開。設計稿、方案比較也用這個，不必先呼叫 list_types。\n'
      + '- kind="html"：單一 HTML 頁面，內容放 html（或 html_path 指向工作目錄裡的 .html 檔）。\n'
      + '- kind="canvas"：設計畫布，內容放 canvas（多個 frame 設計稿 + 問答卡 + 說明卡），適合讓使用者比較方案、釘選留言、作答、標「選這個」。\n'
      + '使用者按「提交」後對話會收到一行 [CODD] 通知，再用 artifact_read_submissions 讀回饋。同一件事要改版請用 artifact_update，不要另開新的。',
    inputSchema: {
      type: 'object',
      required: ['kind', 'title'],
      properties: {
        kind: { type: 'string', enum: ['html', 'canvas'], description: 'html = 單一頁面；canvas = 設計畫布' },
        title: { type: 'string', minLength: 1, maxLength: 120, description: '標題（1–120 字，顯示在 CODD 的 artifact 列表）' },
        html: HTML_SCHEMA,
        html_path: { type: 'string', maxLength: PATH_INPUT_MAX, description: `kind="html" 用：${HTML_PATH_DESC}` },
        canvas: canvasSchema({ forUpdate: false }),
        note: { type: 'string', maxLength: NOTE_MAX, description: '這一版的說明（選填）' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'artifact_update',
    title: '更新 CODD artifact',
    description: '更新既有 artifact，回傳 { id, version, url }（使用者在舊版本有還沒提交的回覆時，另外附 previous_version_draft 與 warning）。'
      + '給 html / html_path（html artifact）或 canvas（canvas artifact）會發布新版本（version +1），使用者的畫面會提示有新版本；只給 title 只改名、不加版本。'
      + 'kind 不能改。只能更新這個 session 建立的 artifact。'
      + 'canvas 改版時沿用原本的 frame / question id，使用者的留言與作答才對得上；canvas 要給完整清單，但沒改的 frame 只給 id 就會沿用目前版本的 HTML。note 是這一版的變更說明。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ARTIFACT_ID_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 120, description: '新標題（選填）' },
        html: { ...HTML_SCHEMA, description: 'html artifact 的新內容（完整的 HTML 文件，限制同 artifact_create）' },
        html_path: { type: 'string', maxLength: PATH_INPUT_MAX, description: `html artifact 用：${HTML_PATH_DESC}` },
        canvas: canvasSchema({ forUpdate: true }),
        note: { type: 'string', maxLength: NOTE_MAX, description: '這一版改了什麼（選填）' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'artifact_get',
    title: '讀取 CODD artifact',
    description: '讀取 artifact 的內容與狀態：標題、目前版本、指定版本的 html 或 canvas、版本列表、提交數、未讀提交數、'
      + '使用者是否有還沒提交的草稿（has_draft）。version 省略 = 最新版。'
      + 'HTML 總量超過 40 KB 時不直接附上（canvas 只列 frame 的 id / 標題 / 尺寸 / 座標 / html_bytes）：'
      + '要看某個 frame 的原文帶 frame_id；html artifact 帶 include_html: true。原文放在回應的第二段，不經 JSON 跳脫。'
      + '要讀使用者的回饋請用 artifact_read_submissions。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ARTIFACT_ID_SCHEMA,
        version: { type: 'integer', minimum: 1, description: '版本號（選填，預設最新）' },
        frame_id: { type: 'string', pattern: ELEMENT_ID_PATTERN, description: 'canvas：只讀這個 frame，HTML 原文放在第二段（選填）' },
        include_html: { type: 'boolean', description: 'html artifact：附上 HTML 原文（第二段）；canvas：不管多大都把每個 frame 的 html 放進 JSON（預設 false）' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'artifact_list',
    title: '列出 CODD artifact',
    description: '列出 CODD 上的 artifact（依更新時間新到舊）：id、kind、標題、目前版本、url、更新時間、未讀提交數。'
      + 'this_session_only=true 只列這個 session 建立的（只有這些能用 artifact_update 改）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `最多幾筆（預設 ${LIST_DEFAULT}）` },
        this_session_only: { type: 'boolean', description: '只列這個 session 建立的（預設 false）' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'artifact_read_submissions',
    title: '讀取使用者的提交',
    description: '讀取使用者在 CODD 上按「提交」送出的回饋：給 Claude 的話、釘選留言（附被點到的元素與座標）、問答作答、標「選這個」的 frame、便利貼、'
      + 'window.codd.submit 送來的資料。對話中出現 [CODD] 通知時呼叫。'
      + '預設只回未讀的提交並標成已讀（mark_read=false 只看不標；不是這個 session 建立的 artifact 一律只看不標）；include_read=true 連已讀的一起回；since_seq 只回編號大於它的提交。'
      + '回傳每次提交的 Markdown 摘要，最後附完整 JSON。單一提交的 JSON 太長放不下時會註明，'
      + '改用 seq（第幾次提交）+ offset 分段讀，讀到最後一段才標成已讀。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: ARTIFACT_ID_SCHEMA,
        since_seq: { type: 'integer', minimum: 0, description: '只回 seq 大於這個值的提交（選填）' },
        include_read: { type: 'boolean', description: '連已讀的也回（預設 false）' },
        mark_read: { type: 'boolean', description: '讀完標成已讀（預設 true）' },
        seq: { type: 'integer', minimum: 1, description: '只讀這一次提交，完整 JSON 分段回傳（選填）' },
        offset: { type: 'integer', minimum: 0, description: '跟 seq 一起用：從 JSON 的第幾個字開始（上一段回應會給下一段的 offset）' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// ── 小工具 ─────────────────────────────────────────────────

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const bad = (msg) => httpError(400, msg);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// 接受 id 或 CODD 的 artifact url（…/artifact/<id>）
function parseArtifactId(v, field = 'id') {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} 必填（artifact id）`);
  let s = v.trim();
  const m = /\/artifacts?\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(s);
  if (m) s = m[1];
  if (!ID_RE.test(s)) throw bad(`${field} 格式不對：artifact id 只有英數、_、-`);
  return s;
}

function optString(args, key, max) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${key} 必須是字串`);
  if (v.length > max) throw bad(`${key} 太長（上限 ${max} 字）`);
  return v;
}

function optInt(args, key, { min, max }) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw bad(`${key} 必須是 ${min}–${max} 的整數`);
  }
  return n;
}

function optBool(args, key, fallback) {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw bad(`${key} 必須是 true 或 false`);
}

// canvas 也接受 JSON 字串（有些時候模型會把巢狀物件序列化成字串送來）
function parseCanvas(v, key = 'canvas') {
  let c = v;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { throw bad(`${key} 必須是物件（或合法的 JSON 字串）`); }
  }
  if (!isPlainObject(c)) throw bad(`${key} 必須是物件，至少要有 frames`);
  return c;
}

function present(v) {
  return v !== undefined && v !== null;
}

function versionOf(a) {
  return a?.version ?? a?.current_version ?? null;
}

function bytesOf(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

function fmtKB(n) {
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// 內容裡最長的反引號串 + 1，當 Markdown code fence
function fenceFor(text) {
  let n = 3;
  for (const r of String(text).match(/`+/g) || []) if (r.length >= n) n = r.length + 1;
  return '`'.repeat(n);
}

class TextResult {
  constructor(text) { this.text = text; }
}

// 多段文字（例如第一段 JSON metadata、第二段 HTML 原文）
class BlocksResult {
  constructor(blocks) { this.blocks = blocks; }
}

function toolOk(value) {
  if (value instanceof BlocksResult) return { content: value.blocks.map(text => ({ type: 'text', text })) };
  const text = value instanceof TextResult ? value.text : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errorMessage(err, toolName) {
  const status = Number(err?.status);
  if (PASS_THROUGH_STATUS.has(status) && typeof err?.message === 'string' && err.message) {
    return err.message;
  }
  // 非預期錯誤：訊息可能帶內部路徑 / SQL，不回給 Claude，只記 server log
  console.error(`[mcp] ${toolName} failed:`, err?.message ?? err);
  return '內部錯誤，請稍後再試';
}

// ── 工具實作 ───────────────────────────────────────────────

export function createArtifactTools({ identity, repo, terminal, insights, publicUrl }) {
  const terminalId = typeof identity?.terminalId === 'string' && identity.terminalId ? identity.terminalId : null;
  const base = String(publicUrl ?? '').replace(/\/+$/, '');
  const urlFor = (id) => `${base}/artifact/${encodeURIComponent(id)}`;

  const notFound = (id, version) => httpError(404, version
    ? `找不到 artifact ${id} 的 v${version}`
    : `找不到 artifact ${id}（可能已刪除，可用 artifact_list 查）`);

  // 建立者的顯示名：Claude 的 session 標題，沒有就用 launch profile 名稱
  async function originLabel() {
    if (!terminalId) return null;
    const rec = terminal?.get?.(terminalId);
    if (!rec) return null;
    let title = null;
    try { title = (await insights?.enrichOne?.(rec))?.title ?? null; } catch {}
    return cleanText(title, LABEL_MAX) ?? cleanText(rec.profile_name, LABEL_MAX) ?? null;
  }

  // 這個連線能不能改這個 artifact：建立它的 session，或 restart 後接手的那個（resolveLive 沿 replaced_by 找到的活 session）。
  // host token 只能改 origin 是 NULL（host token 建立）的
  function ownsArtifact(meta) {
    const origin = meta?.origin_terminal_id ?? null;
    if (!terminalId) return origin === null;
    if (!origin) return false;
    if (origin === terminalId) return true;
    try { return terminal?.resolveLive?.(origin)?.id === terminalId; } catch { return false; }
  }

  const notOwner = (id) => httpError(403, terminalId
    ? `artifact ${id} 不是這個 session 建立的，不能修改。要改版請用 artifact_create 另開一個，或請使用者在 CODD 的 artifact 頁面把它交給這個 session。`
    : `artifact ${id} 是 CODD 開的 session 建立的，host token 不能修改。`);

  // html_path：只給 CODD 開、還在跑的 session 用，檔案（realpath 後）必須在該 session 的工作目錄底下、是 .html / .htm 一般檔案。
  // 錯誤訊息只提工作目錄裡的相對路徑，不回顯工作目錄以外的路徑
  let cwdCache;
  async function sessionCwd() {
    if (cwdCache !== undefined) return cwdCache;
    cwdCache = null;
    if (!terminalId) return null;
    const rec = terminal?.get?.(terminalId);
    if (!rec || rec.status !== 'running' || typeof rec.cwd !== 'string' || !rec.cwd) return null;
    try { cwdCache = await realpath(rec.cwd); } catch { cwdCache = null; }
    return cwdCache;
  }

  async function readHtmlFile(p, field, maxBytes) {
    if (typeof p !== 'string' || !p.trim()) throw bad(`${field} 必須是非空字串（.html 檔的路徑）`);
    if (p.length > PATH_INPUT_MAX || p.includes('\0')) throw bad(`${field} 格式不對`);
    const cwd = await sessionCwd();
    if (!cwd) {
      throw bad(`${field} 只能在 CODD 開的 session 裡用（這個連線沒有工作目錄）；請改用 html 直接給內容`);
    }
    const abs = isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p);
    let real;
    try { real = await realpath(abs); } catch (e) {
      const inside = abs.startsWith(cwd + sep);
      throw bad(inside ? `${field}：找不到 ${relative(cwd, abs)}` : `${field}：找不到檔案（必須在工作目錄 ${cwd} 底下）`);
    }
    if (!real.startsWith(cwd + sep)) throw bad(`${field} 必須是這個 session 工作目錄（${cwd}）底下的檔案`);
    const rel = relative(cwd, real);
    if (!HTML_EXT_RE.test(real)) throw bad(`${field}：${rel} 不是 .html / .htm 檔`);
    let fh;
    try {
      fh = await openFile(real, 'r');
      const st = await fh.stat();
      if (!st.isFile()) throw bad(`${field}：${rel} 不是一般檔案`);
      if (st.size > maxBytes) throw httpError(413, `${field}：${rel} 有 ${fmtKB(st.size)}，超過上限 ${fmtKB(maxBytes)}`);
      if (st.size === 0) throw bad(`${field}：${rel} 是空的`);
      const html = await fh.readFile({ encoding: 'utf8' });
      if (bytesOf(html) > maxBytes) throw httpError(413, `${field}：${rel} 超過上限 ${fmtKB(maxBytes)}`);
      return html;
    } catch (e) {
      if (e?.status) throw e;
      throw bad(`${field}：讀不到 ${rel}`);
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // html / html_path 二擇一 → HTML 字串（都沒給 → undefined）
  async function htmlFrom(args, maxBytes, prefix = '') {
    const hasHtml = present(args.html);
    const hasPath = present(args.html_path);
    if (hasHtml && hasPath) throw bad(`${prefix}html 和 ${prefix}html_path 只能給一個`);
    if (hasPath) return readHtmlFile(args.html_path, `${prefix}html_path`, maxBytes);
    return hasHtml ? args.html : undefined;
  }

  // canvas.frames[]：html_path 換成檔案內容；update 時沒給 html 的 frame 沿用目前版本同 id 的 frame
  async function resolveFrames(canvas, prevSpec) {
    if (!Array.isArray(canvas.frames)) return canvas;
    const prev = new Map((prevSpec?.frames ?? []).map(f => [f.id, f]));
    const maxTotal = repo.maxContentBytes ?? Infinity;
    let total = 0;
    const frames = [];
    for (let i = 0; i < canvas.frames.length; i++) {
      const f = canvas.frames[i];
      if (!isPlainObject(f)) { frames.push(f); continue; }
      const path = `canvas.frames[${i}].`;
      const html = await htmlFrom(f, FRAME_HTML_MAX_BYTES, path);
      const { html_path: _drop, ...rest } = f;
      if (typeof html === 'string') {
        // 讀檔讀到一半就超過整體上限：不用等全部讀完才由 repo 拒絕
        total += bytesOf(html);
        if (total > maxTotal) throw httpError(413, `canvas 的 frame HTML 合計超過 ${fmtKB(maxTotal)}`);
      }
      if (html !== undefined) { frames.push({ ...rest, html }); continue; }
      if (prevSpec) {
        const old = typeof f.id === 'string' ? prev.get(f.id) : null;
        if (!old) {
          throw bad(typeof f.id === 'string' && f.id
            ? `canvas.frames[${i}] 沒有 html，目前版本也沒有 id 為「${f.id.slice(0, 40)}」的 frame 可沿用`
            : `canvas.frames[${i}] 沒有 html（只給 id 時會沿用目前版本同 id 的 frame）`);
        }
        const merged = { ...rest, html: old.html };
        for (const k of ['title', 'width', 'height', 'x', 'y']) if (!present(f[k])) merged[k] = old[k];
        frames.push(merged);
        continue;
      }
      frames.push(rest); // create：交給 repo 回「html 不能是空的」
    }
    return { ...canvas, frames };
  }

  function summarize(meta, spec, sub, dataHint) {
    let s;
    try {
      s = String(summarizeSubmission({ artifact: meta, spec, submission: sub, ...(dataHint !== undefined ? { dataHint } : {}) }) ?? '');
    } catch (e) {
      console.error('[mcp] summarizeSubmission failed:', e?.message ?? e);
      s = `## 提交 #${sub.seq}（v${sub.version}）\n（摘要產生失敗，請看 JSON）`;
    }
    if (s.length > SUMMARY_MAX) s = s.slice(0, SUMMARY_MAX) + '\n…（摘要太長，已截斷）';
    return s;
  }

  return {
    async artifact_create(args) {
      const kind = args.kind;
      if (kind !== 'html' && kind !== 'canvas') throw bad('kind 必須是 "html" 或 "canvas"');
      const title = optString(args, 'title', TITLE_INPUT_MAX);
      if (!title || !title.trim()) throw bad('title 必填');
      const note = optString(args, 'note', NOTE_MAX);
      let html, canvas;
      if (kind === 'html') {
        if (present(args.canvas)) throw bad('kind="html" 不能帶 canvas；畫布請用 kind="canvas"');
        html = await htmlFrom(args, repo.maxContentBytes ?? Infinity);
        if (typeof html !== 'string' || !html.trim()) throw bad('kind="html" 需要 html（完整的 HTML 文件）或 html_path');
      } else {
        if (present(args.html) || present(args.html_path)) throw bad('kind="canvas" 不能帶 html / html_path；請把頁面放進 canvas.frames[].html（或 frames[].html_path）');
        if (!present(args.canvas)) throw bad('kind="canvas" 需要 canvas（至少一個 frame）');
        canvas = await resolveFrames(parseCanvas(args.canvas), null);
      }
      const created = repo.create({
        kind, title, html, canvas, note,
        originTerminalId: terminalId,
        originLabel: await originLabel(),
      });
      if (!created) throw new Error('create returned nothing');
      return { id: created.id, kind: created.kind, title: created.title, version: versionOf(created), url: urlFor(created.id) };
    },

    async artifact_update(args) {
      const id = parseArtifactId(args.id);
      const meta = repo.getMeta(id);
      if (!meta) throw notFound(id);
      if (!ownsArtifact(meta)) throw notOwner(id);
      const patch = {};
      const title = optString(args, 'title', TITLE_INPUT_MAX);
      if (title !== undefined) patch.title = title;
      if (present(args.html) || present(args.html_path)) {
        if (meta.kind !== 'html') throw bad(`artifact ${id} 是 canvas，請用 canvas 更新（kind 不能改）`);
        const html = await htmlFrom(args, repo.maxContentBytes ?? Infinity);
        if (typeof html !== 'string' || !html.trim()) throw bad('html 必須是非空的 HTML 字串');
        patch.html = html;
      }
      if (present(args.canvas)) {
        if (meta.kind !== 'canvas') throw bad(`artifact ${id} 是 html，請用 html 更新（kind 不能改）`);
        let prevSpec = null;
        try { prevSpec = repo.getSpec?.(id, meta.current_version) ?? null; } catch {}
        patch.canvas = await resolveFrames(parseCanvas(args.canvas), prevSpec ?? { frames: [] });
      }
      if (patch.title === undefined && patch.html === undefined && patch.canvas === undefined) {
        throw bad('至少要給 title、html 或 canvas 其中一個');
      }
      const note = optString(args, 'note', NOTE_MAX);
      if (note !== undefined) patch.note = note;

      // 發新版本前看使用者在目前版本有沒有還沒提交的回覆：舊版本不能再提交，要提醒
      let draft = null;
      if (patch.html !== undefined || patch.canvas !== undefined) {
        try {
          const d = repo.getDraft?.(id, meta.current_version);
          if (d?.payload && !isEmptyPayload(d.payload)) draft = { version: meta.current_version, ...payloadCounts(d.payload) };
        } catch {}
      }
      const updated = repo.update(id, patch);
      if (!updated) throw notFound(id);
      const out = { id, version: versionOf(updated), url: urlFor(id) };
      if (draft && out.version !== draft.version) {
        const parts = [];
        if (draft.comments) parts.push(`留言 ${draft.comments}`);
        if (draft.answers) parts.push(`作答 ${draft.answers}`);
        if (draft.selected) parts.push(`選擇 ${draft.selected}`);
        if (draft.stickies) parts.push(`便利貼 ${draft.stickies}`);
        if (draft.has_message) parts.push('給 Claude 的話');
        if (draft.has_data) parts.push('頁面資料');
        out.previous_version_draft = draft;
        out.warning = `使用者在 v${draft.version} 還有沒提交的回覆（${parts.join('、') || '內容'}），舊版本不能再提交。`
          + `請告訴使用者已發布 v${out.version}、要切到新版本再提交；frame / 題目 id 沒變的部分才帶得過去。`;
      }
      return out;
    },

    async artifact_get(args) {
      const id = parseArtifactId(args.id);
      const version = optInt(args, 'version', { min: 1, max: 1e9 });
      const frameId = optString(args, 'frame_id', 64);
      if (frameId !== undefined && frameId !== HTML_FRAME_ID && !ELEMENT_ID_RE.test(frameId)) throw bad('frame_id 格式不對');
      const includeHtml = optBool(args, 'include_html', false);
      const a = repo.get(id, version ? { version } : {});
      if (!a) throw notFound(id, version);
      let hasDraft = false;
      try { hasDraft = Boolean(repo.getDraft(id, versionOf(a))); } catch {}
      let versions = [];
      try { versions = repo.versions(id) ?? []; } catch {}
      const content = a.content ?? {};
      const info = {
        id: a.id,
        kind: a.kind,
        title: a.title,
        url: urlFor(a.id),
        current_version: a.current_version,
        version: versionOf(a),
        note: a.note ?? null,
        version_created_at: a.version_created_at ?? null,
        origin_terminal_id: a.origin_terminal_id ?? null,
        origin_label: a.origin_label ?? null,
        created_at: a.created_at,
        updated_at: a.updated_at,
        submission_count: a.submission_count ?? 0,
        unread_count: a.unread_count ?? 0,
        last_submission_at: a.last_submission_at ?? null,
        has_draft: hasDraft,
        versions,
      };

      if (a.kind !== 'canvas') {
        const html = typeof content.html === 'string' ? content.html : '';
        const htmlBytes = bytesOf(html);
        if (frameId !== undefined && frameId !== HTML_FRAME_ID) throw bad(`artifact ${id} 是 html，只有一個頁面（frame_id 只能是 main 或省略）`);
        if (includeHtml || frameId === HTML_FRAME_ID) {
          return new BlocksResult([
            JSON.stringify({ ...info, html_bytes: htmlBytes }, null, 2) + '\n\n（下一段是 HTML 原文）',
            html,
          ]);
        }
        if (htmlBytes > INLINE_HTML_MAX) {
          return {
            ...info,
            html: null,
            html_bytes: htmlBytes,
            hint: `HTML 有 ${fmtKB(htmlBytes)}，太長不直接附上：要看原文帶 include_html: true（原文放在第二段，不經 JSON 跳脫）`,
          };
        }
        return { ...info, html };
      }

      const canvas = isPlainObject(content.canvas) ? content.canvas : { frames: [], questions: [], notes: [] };
      const frames = Array.isArray(canvas.frames) ? canvas.frames : [];
      if (frameId !== undefined) {
        const f = frames.find(x => x.id === frameId);
        if (!f) {
          throw httpError(404, `artifact ${id} 的 v${info.version} 沒有 id 為「${frameId}」的 frame（有：${frames.map(x => x.id).join('、') || '無'}）`);
        }
        const { html, ...fmeta } = f;
        return new BlocksResult([
          JSON.stringify({ ...info, frame: { ...fmeta, html_bytes: bytesOf(html) } }, null, 2) + '\n\n（下一段是這個 frame 的 HTML 原文）',
          String(html ?? ''),
        ]);
      }
      const total = frames.reduce((n, f) => n + bytesOf(f.html), 0);
      if (!includeHtml && total > INLINE_HTML_MAX) {
        return {
          ...info,
          canvas: {
            ...canvas,
            frames: frames.map(({ html, ...f }) => ({ ...f, html_bytes: bytesOf(html) })),
          },
          hint: `frame 的 HTML 共 ${fmtKB(total)}，太長不直接附上：要看某個 frame 的原文帶 frame_id。`
            + 'artifact_update 時沒改的 frame 只給 id（不給 html）就會沿用目前版本的 HTML。',
        };
      }
      return { ...info, canvas };
    },

    async artifact_list(args) {
      const limit = optInt(args, 'limit', { min: 1, max: LIST_MAX }) ?? LIST_DEFAULT;
      const thisOnly = optBool(args, 'this_session_only', false);
      const opts = { limit };
      let note;
      if (thisOnly) {
        if (terminalId) opts.originTerminalId = terminalId;
        else note = '這個 session 不是 CODD 開的（用 host token 連線），沒有「這個 session」可篩，已列出全部';
      }
      const items = (repo.list(opts) ?? []).map(m => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        version: m.current_version,
        url: urlFor(m.id),
        updated_at: m.updated_at,
        unread_count: m.unread_count ?? 0,
      }));
      return note ? { items, note } : { items };
    },

    async artifact_read_submissions(args) {
      const id = parseArtifactId(args.id);
      const sinceSeq = optInt(args, 'since_seq', { min: 0, max: 1e9 }) ?? 0;
      const includeRead = optBool(args, 'include_read', false);
      let markRead = optBool(args, 'mark_read', true);
      const seq = optInt(args, 'seq', { min: 1, max: 1e9 });
      const offset = optInt(args, 'offset', { min: 0, max: 1e9 }) ?? 0;
      if (offset && seq === undefined) throw bad('offset 要跟 seq 一起用（分段讀某一次提交的完整 JSON）');
      const meta = repo.getMeta(id);
      if (!meta) throw notFound(id);

      let head = `# artifact「${cleanText(meta.title, LABEL_MAX) ?? id}」(${id})，目前 v${meta.current_version}\n${urlFor(id)}`;
      // 別的 session 的 artifact：可以看，但不替它標已讀（不然它收到通知時會讀不到）
      if (markRead && !ownsArtifact(meta)) {
        markRead = false;
        head += '\n（這個 artifact 不是這個 session 建立的：只能看，不會標成已讀）';
      }

      // 摘要要用提交當時那個版本的 canvas spec（frame 標題、題目）
      const specs = new Map();
      const specFor = (v) => {
        if (meta.kind !== 'canvas') return null;
        if (!specs.has(v)) {
          let spec = null;
          try {
            spec = typeof repo.getSpec === 'function'
              ? repo.getSpec(id, v)
              : repo.get(id, { version: v })?.content?.canvas ?? null;
          } catch {}
          specs.set(v, spec);
        }
        return specs.get(v);
      };
      const entryOf = (sub) => ({ seq: sub.seq, version: sub.version, created_at: sub.created_at, payload: sub.payload });

      // ── 只讀某一次提交：完整 JSON 分段 ──
      if (seq !== undefined) {
        const sub = typeof repo.getSubmissionBySeq === 'function'
          ? repo.getSubmissionBySeq(id, seq)
          : (repo.listSubmissions(id, { sinceSeq: seq - 1, limit: 1 }) ?? []).find(s => s.seq === seq) ?? null;
        if (!sub) throw httpError(404, `artifact ${id} 沒有第 ${seq} 次提交`);
        const json = JSON.stringify(entryOf(sub), null, 2);
        if (offset > json.length) throw bad(`offset 超過範圍（提交 #${seq} 的 JSON 共 ${json.length} 字）`);
        const parts = [head];
        let room = READ_TEXT_BUDGET - head.length - 400;
        if (offset === 0) {
          const summary = summarize(meta, specFor(sub.version), sub, '完整內容見下方 JSON 的 payload.data');
          parts.push(summary);
          room -= summary.length;
        }
        room = Math.max(CHUNK_MIN, room);
        let end = Math.min(json.length, offset + room);
        // 不要切在 surrogate pair 中間
        if (end < json.length && end > offset) {
          const c = json.charCodeAt(end - 1);
          if (c >= 0xd800 && c <= 0xdbff) end--;
        }
        const chunk = json.slice(offset, end);
        const done = end >= json.length;
        const fence = fenceFor(chunk);
        parts.push(`---\n提交 #${seq} 的完整資料（JSON，第 ${offset}–${end} 字，共 ${json.length} 字）：\n${fence}json\n${chunk}\n${fence}`);
        if (!done) {
          parts.push(`（還沒完：帶 { id: "${id}", seq: ${seq}, offset: ${end} } 讀下一段${markRead && !sub.read_at ? '；讀到最後一段才會標成已讀' : ''}）`);
        } else if (markRead && !sub.read_at) {
          repo.markRead(id, [seq]);
        }
        return new TextResult(parts.join('\n\n'));
      }

      // ── 一批提交：摘要 + 完整 JSON ──
      // 多拿一筆，用來判斷後面還有沒有
      const fetched = repo.listSubmissions(id, { sinceSeq, unreadOnly: !includeRead, limit: SUBMISSIONS_BATCH + 1 }) ?? [];
      const subs = fetched.slice(0, SUBMISSIONS_BATCH);
      if (!subs.length) {
        return new TextResult(`${head}\n\n${includeRead || sinceSeq
          ? '沒有符合條件的提交。'
          : '沒有未讀的提交。（要重看已讀的，帶 include_read: true）'}`);
      }

      const artifactInfo = { id, kind: meta.kind, title: meta.title, current_version: meta.current_version, url: urlFor(id) };
      // 外框（head、artifact JSON、fence、結尾提示）的大概長度
      const baseUsed = head.length + JSON.stringify(artifactInfo, null, 2).length + 600;
      // entry 放進 { submissions: [...] } 之後每行多縮排 4 格
      const nestedLen = (obj) => {
        const s = JSON.stringify(obj, null, 2);
        return s.length + 4 * (s.split('\n').length) + 2;
      };
      const included = []; // { sub, summary, entry, full }
      let used = baseUsed;
      for (const sub of subs) {
        const entry = entryOf(sub);
        const entryLen = nestedLen(entry);
        const summary = summarize(meta, specFor(sub.version), sub);
        const cost = summary.length + entryLen + 4;
        if (used + cost <= READ_TEXT_BUDGET) {
          included.push({ sub, summary, entry, full: true });
          used += cost;
          continue;
        }
        // 單獨一筆放得下：留到下一批
        if (baseUsed + cost <= READ_TEXT_BUDGET) break;
        // 單獨一筆也放不下：只附摘要，JSON 改成提示用 seq 分段讀（不標已讀）
        const rawLen = JSON.stringify(entry, null, 2).length;
        const stubSummary = summarize(meta, specFor(sub.version), sub, `完整內容用 artifact_read_submissions 帶 seq: ${sub.seq} 分段讀`);
        const stub = { seq: sub.seq, version: sub.version, created_at: sub.created_at, payload_omitted: true, payload_json_chars: rawLen };
        const stubCost = stubSummary.length + nestedLen(stub) + 4;
        if (included.length && used + stubCost > READ_TEXT_BUDGET) break;
        included.push({ sub, summary: stubSummary, entry: stub, full: false });
        used += stubCost;
      }

      const json = JSON.stringify({ artifact: artifactInfo, submissions: included.map(x => x.entry) }, null, 2);
      const fence = fenceFor(json);
      const parts = [head, ...included.map(x => x.summary), `---\n完整資料（JSON）：\n${fence}json\n${json}\n${fence}`];
      const stubs = included.filter(x => !x.full).map(x => x.sub.seq);
      if (stubs.length) {
        parts.push(`（提交 ${stubs.map(s => `#${s}`).join('、')} 的完整 JSON 太長、沒有附上：用 artifact_read_submissions 帶 { id: "${id}", seq: <編號> } 分段讀，`
          + `${markRead ? '讀完最後一段才會標成已讀' : '這次不會標成已讀'}）`);
      }
      const more = included.length < fetched.length;
      if (more) {
        const last = included[included.length - 1].sub.seq;
        parts.push(markRead && !includeRead
          ? '（還有更多提交，再呼叫一次 artifact_read_submissions 讀下一批）'
          : `（還有更多提交，帶 since_seq: ${last} 讀下一批）`);
      }

      if (markRead) {
        const seqs = included.filter(x => x.full && !x.sub.read_at).map(x => x.sub.seq);
        if (seqs.length) repo.markRead(id, seqs);
      }
      return new TextResult(parts.join('\n\n'));
    },
  };
}

export function createArtifactMcpServer({ identity, repo, terminal, insights, publicUrl }) {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });
  const handlers = createArtifactTools({ identity, repo, terminal, insights, publicUrl });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // 工具錯誤一律回 isError（繁中訊息），不 throw 到 transport
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return toolError(`沒有這個工具：${cleanText(String(name ?? ''), 64) ?? '(空白)'}`);
    const args = isPlainObject(request.params?.arguments) ? request.params.arguments : {};
    try {
      return toolOk(await handler(args));
    } catch (err) {
      return toolError(errorMessage(err, name));
    }
  });

  return server;
}
