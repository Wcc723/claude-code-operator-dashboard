import { Router } from 'express';
import {
  ARTIFACT_ID_RE, ELEMENT_ID_RE, HTML_FRAME_ID, payloadCounts, unreadPayload,
} from '../services/artifact-repo.js';
import { FRAME_CSP, buildFrameDocument } from '../services/artifact-frame.js';
import { sanitizeColor } from '../services/colors.js';

// /api/artifacts：瀏覽器端（登入後）看 artifact、存草稿、提交回覆。全部掛在 protect 後面。
// SPA 拿不到原始 HTML：只拿 iframe src，HTML 由 frame 路由加上 bridge 與 sandbox CSP 後送進 iframe。

const LIST_MAX = 200;
const SUBMISSIONS_MAX = 100;

function meta(a) {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    current_version: a.current_version,
    origin_terminal_id: a.origin_terminal_id,
    origin_label: a.origin_label,
    created_at: a.created_at,
    updated_at: a.updated_at,
    submission_count: a.submission_count,
    unread_count: a.unread_count,
    last_submission_at: a.last_submission_at,
  };
}

function frameSrc(id, version, frameId) {
  return `/api/artifacts/${id}/v/${version}/frame/${encodeURIComponent(frameId)}`;
}

function parseVersion(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  return /^\d{1,9}$/.test(s) && Number(s) >= 1 ? Number(s) : null;
}

// 草稿的併發檢查用的 base（上次看到的 draft_updated_at；null = 當時沒有草稿）。沒帶 → undefined（不檢查，舊呼叫端）
function draftBase(body) {
  if (!Object.hasOwn(body, 'base_updated_at')) return undefined;
  const b = body.base_updated_at;
  if (b === null || (typeof b === 'string' && b.length <= 64)) return b;
  const e = new Error('base_updated_at 必須是字串或 null');
  e.status = 400;
  throw e;
}

export function artifactsRouter({ repo, notifier, terminal, insights = null }) {
  const router = Router();

  // 來源 session：restart 過就沿著 replaced_by 找到現在活著的那個（點進去才開得到）
  function origin(a) {
    let rec = null;
    if (a.origin_terminal_id && terminal) {
      try {
        rec = typeof terminal.resolveLive === 'function'
          ? terminal.resolveLive(a.origin_terminal_id)
          : (terminal.get?.(a.origin_terminal_id)?.status === 'running' ? terminal.get(a.origin_terminal_id) : null);
      } catch { rec = null; }
    }
    return {
      terminal_id: rec?.id ?? a.origin_terminal_id ?? null,
      label: a.origin_label ?? rec?.profile_name ?? null,
      alive: Boolean(rec),
      color: sanitizeColor(rec?.color),
    };
  }

  const withOrigin = (a) => ({ ...meta(a), origin: origin(a) });

  // async handler 的錯誤：帶 status 的（repo 丟的 400/404/409/413）直接回訊息，其他交給全域 error handler
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500) {
        // repo 附的額外欄位（例如草稿衝突的 code / draft_updated_at）一起回，讓前端知道要重新載入
        const extra = e.extra && typeof e.extra === 'object' ? e.extra : {};
        return res.status(e.status).json({ ...extra, error: e.message });
      }
      next(e);
    }
  };

  router.param('id', (req, res, next, id) => {
    if (ARTIFACT_ID_RE.test(id)) return next();
    // frame 路由回純文字（iframe 裡顯示），其他回 JSON
    if (req.path.includes('/frame/')) return res.status(404).type('text/plain; charset=utf-8').send('not found');
    res.status(404).json({ error: '找不到這個 artifact' });
  });

  router.get('/', wrap((req, res) => {
    const session = typeof req.query.session === 'string' && req.query.session.length <= 64 ? req.query.session : undefined;
    const limit = Math.min(LIST_MAX, Math.max(1, Number(req.query.limit) || 50));
    const items = repo.list({ limit, originTerminalId: session || undefined }).map(withOrigin);
    res.json({ items });
  }));

  router.get('/:id', wrap((req, res) => {
    const id = req.params.id;
    const v = parseVersion(req.query.v);
    if (v === null) return res.status(400).json({ error: 'v 必須是正整數' });
    const a = repo.get(id, { version: v });
    if (!a) {
      if (!repo.getMeta(id)) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
      return res.status(404).json({ error: `沒有 v${v} 這個版本` });
    }
    let view;
    if (a.kind === 'html') {
      view = { kind: 'html', frame: { id: HTML_FRAME_ID, src: frameSrc(a.id, a.version, HTML_FRAME_ID) } };
    } else {
      const spec = a.content.canvas || {};
      view = {
        kind: 'canvas',
        frames: (spec.frames || []).map(({ html, ...f }) => ({ ...f, src: frameSrc(a.id, a.version, f.id) })),
        questions: spec.questions || [],
        notes: spec.notes || [],
      };
    }
    const draft = repo.getDraft(a.id, a.version);
    res.json({
      artifact: withOrigin(a),
      version: a.version,
      note: a.note ?? null,
      version_created_at: a.version_created_at ?? null,
      versions: repo.versions(a.id),
      view,
      draft: draft ? draft.payload : null,
      draft_updated_at: draft ? draft.updated_at : null,
      // Claude 讀過這一版的草稿沒有（輪詢也走這裡）。標已讀不會改 draft_updated_at
      draft_read_at: draft ? draft.read_at : null,
      draft_unread: draft ? draft.unread : false,
    });
  }));

  // 某一版的草稿與已讀狀態。unread_payload 只有 Claude 還沒讀過的內容：切到新版本時用它決定要帶什麼過去，
  // read_payload 是 Claude 上次讀到的內容（帶過去的項目要從舊版本拿掉時，改過的要還原成這一份）
  router.get('/:id/draft', wrap((req, res) => {
    const id = req.params.id;
    const v = parseVersion(req.query.v);
    if (v === null) return res.status(400).json({ error: 'v 必須是正整數' });
    const m = repo.getMeta(id);
    if (!m) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    const version = v ?? m.current_version;
    const draft = repo.getDraft(id, version);
    res.json({
      version,
      draft: draft ? draft.payload : null,
      draft_updated_at: draft ? draft.updated_at : null,
      draft_read_at: draft ? draft.read_at : null,
      draft_unread: draft ? draft.unread : false,
      read_payload: draft ? draft.read_payload : null,
      unread_payload: draft ? unreadPayload(draft.read_payload, draft.payload) : null,
    });
  }));

  // iframe 內容：sandbox CSP + bridge。覆蓋全域 middleware 設的同名 header
  router.get('/:id/v/:version/frame/:frameId', wrap((req, res) => {
    const { id, frameId } = req.params;
    const v = parseVersion(req.params.version);
    const notFound = () => res.status(404).type('text/plain; charset=utf-8').send('not found');
    if (!v || (frameId !== HTML_FRAME_ID && !ELEMENT_ID_RE.test(frameId))) return notFound();
    const html = repo.getFrameHtml(id, v, frameId);
    if (html === null || html === undefined) return notFound();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', FRAME_CSP);
    // no-transform：Cloudflare 不改寫 artifact HTML（Rocket Loader、Email Obfuscation、自動注入的 Web Analytics beacon）
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(buildFrameDocument(html, { frameId }));
  }));

  // base_updated_at（選填）：上次 GET / PUT 拿到的 draft_updated_at；跟目前存的不同 → 409 { code: 'draft_conflict', draft_updated_at }。
  // 草稿只存著等 Claude 來讀：這裡不通知 session，也不會往終端機打任何字。
  // 回傳的 kept 是正規化後各類的數量（版本換了、對不上的留言 / 作答會被丟掉，前端可以跟自己送出的比）
  router.put('/:id/draft', wrap((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.hasOwn(body, 'payload')) return res.status(400).json({ error: 'payload 必填' });
    const baseReadAt = body.base_read_at === null || (typeof body.base_read_at === 'string' && body.base_read_at.length <= 64)
      ? body.base_read_at
      : undefined;
    const r = repo.saveDraft(req.params.id, body.version, body.payload, { base: draftBase(body), baseReadAt });
    res.json({
      ok: true,
      updated_at: r.updated_at,
      kept: payloadCounts(r.payload),
      draft_read_at: r.read_at,
      draft_unread: r.unread,
    });
  }));

  router.post('/:id/submissions', wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.hasOwn(body, 'payload')) return res.status(400).json({ error: 'payload 必填' });
    const wantNotify = !(body.notify === false || body.notify === 'false' || body.notify === 0);
    const submission = repo.addSubmission(req.params.id, {
      version: body.version, payload: body.payload, draftBase: draftBase(body),
    });
    const artifact = repo.getMeta(req.params.id);
    let notify;
    try {
      notify = notifier
        ? await notifier.notify({ artifact, submission, notify: wantNotify })
        : { status: 'none', session_label: artifact?.origin_label ?? null };
    } catch (e) {
      console.error('[artifacts] notify failed:', e?.message);
      try { repo.setNotifyStatus(submission.id, 'failed'); } catch {}
      notify = { status: 'failed', session_label: artifact?.origin_label ?? null };
    }
    res.status(201).json({ submission: { ...submission, notify_status: notify.status }, notify });
  }));

  router.get('/:id/submissions', wrap((req, res) => {
    if (!repo.getMeta(req.params.id)) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    const items = repo.listSubmissions(req.params.id, { limit: SUBMISSIONS_MAX, order: 'desc' })
      .map(s => ({ ...s, summary_counts: payloadCounts(s.payload) }));
    res.json({ items });
  }));

  router.patch('/:id', wrap((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.hasOwn(body, 'title')) return res.status(400).json({ error: 'title 必填' });
    const a = repo.rename(req.params.id, body.title);
    if (!a) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    res.json({ artifact: withOrigin(a) });
  }));

  // 把 artifact 交給另一個還在跑的 CODD session（必須是掛了 artifact MCP 的 claude）：之後由它用 artifact_update 改版、收提交通知。
  // MCP 端只讓建立者（含 restart 後接手的）改，全新開的 session 要靠這個接手
  router.put('/:id/origin', wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const tid = body.terminal_id;
    if (typeof tid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(tid)) return res.status(400).json({ error: 'terminal_id 必填' });
    if (!repo.getMeta(req.params.id)) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    let rec = null;
    try { rec = terminal?.resolveLive?.(tid, { requireMcp: true }) ?? null; } catch { rec = null; }
    if (!rec || rec.id !== tid) {
      return res.status(409).json({ error: '這個 session 沒有在跑，或不是掛了 artifact 工具的 Claude session' });
    }
    let label = null;
    try { label = (await insights?.enrichOne?.(rec))?.title ?? null; } catch {}
    const a = repo.setOrigin(req.params.id, tid, label || rec.profile_name || null);
    if (!a) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    res.json({ artifact: withOrigin(a) });
  }));

  router.delete('/:id', wrap((req, res) => {
    if (!repo.remove(req.params.id)) return res.status(404).json({ error: '找不到這個 artifact（可能已刪除）' });
    res.json({ ok: true });
  }));

  return router;
}
