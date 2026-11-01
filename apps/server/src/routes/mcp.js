import express, { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createArtifactMcpServer } from '../services/artifact-mcp.js';

// CODD artifact MCP 的 HTTP 端點（Streamable HTTP，stateless：每個 POST 一組 server + transport）。
// 不經過 Google 登入的 protect，改用 bearer token（McpTokens），而且只接受本機直連：
// 經 Cloudflare Tunnel 進來的請求一定帶 cf-connecting-ip / x-forwarded-for，一律 403。
// index.js 的全域 express.json（2mb）要跳過 /api/mcp，這裡自己用比較大的 parser（canvas 可以到幾 MB）：
// 至少 8 MiB；CODD_ARTIFACT_MAX_BYTES 調大時跟著放大（內容 × 2 給 JSON 跳脫，再加 64 KiB 給其他欄位），
// 不然內容還沒到 repo 的上限，就先被 body parser 以 413 擋掉。

const MiB = 1024 * 1024;
const BODY_LIMIT_MIN = 8 * MiB;

export function mcpBodyLimit(maxContentBytes) {
  const n = Number(maxContentBytes);
  const derived = Number.isFinite(n) && n > 0 ? 2 * n + 64 * 1024 : 0;
  return Math.max(BODY_LIMIT_MIN, Math.ceil(derived));
}

function fmtLimit(bytes) {
  return `${Math.round((bytes / MiB) * 10) / 10}mb`;
}
const FORWARDED_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-real-ip'];
const BEARER_RE = /^Bearer[ \t]+(\S{1,512})[ \t]*$/i;

function isLoopback(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// 本機直連：loopback，或從本機自己的位址連進來（HOST 綁在區網 IP 時，claude 會連那個 IP）
function isLocalSocket(req) {
  const remote = req.socket?.remoteAddress;
  if (isLoopback(remote)) return true;
  const local = req.socket?.localAddress;
  return typeof remote === 'string' && remote.length > 0 && remote === local;
}

function jsonRpcError(res, status, code, message) {
  return res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function mcpRouter({ tokens, repo, terminal, insights, publicUrl }) {
  if (!tokens) throw new Error('mcpRouter: tokens is required');
  const router = Router();
  const bodyLimit = mcpBodyLimit(repo?.maxContentBytes);

  // 1. 只接受本機直連（先檢查，不給經 tunnel 進來的人試 token）
  router.use((req, res, next) => {
    if (FORWARDED_HEADERS.some(h => req.headers[h] !== undefined) || !isLocalSocket(req)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  // 2. bearer token（在讀 body 之前：沒通過驗證的請求不解析好幾 MB 的 body）
  router.use((req, res, next) => {
    const m = BEARER_RE.exec(String(req.headers.authorization ?? ''));
    const identity = m ? tokens.resolve(m[1]) : null;
    if (!identity) return res.status(401).json({ error: 'unauthorized' });
    res.locals.mcpIdentity = { terminalId: identity.terminalId ?? null };
    next();
  });

  router.post('/', express.json({ limit: bodyLimit }), async (req, res) => {
    const server = createArtifactMcpServer({
      identity: res.locals.mcpIdentity, repo, terminal, insights, publicUrl,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    let closed = false;
    res.on('close', () => {
      if (closed) return;
      closed = true;
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed:', e?.message ?? e);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
    }
  });

  // stateless：沒有 SSE stream（GET）也沒有 session 可刪（DELETE）
  router.all('/', (req, res) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
  });

  router.use((req, res) => res.status(404).json({ error: 'not found' }));

  // body parser 的錯誤（太大 / 不是 JSON）回 JSON-RPC 格式；其他錯誤不外流細節
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.too.large') return jsonRpcError(res, 413, -32600, `Request too large (max ${fmtLimit(bodyLimit)})`);
    if (err?.type === 'entity.parse.failed') return jsonRpcError(res, 400, -32700, 'Parse error');
    if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      return jsonRpcError(res, 415, -32000, 'Unsupported encoding');
    }
    console.error('[mcp] error:', err?.message ?? err);
    jsonRpcError(res, Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500, -32603, 'Internal error');
  });

  return router;
}
