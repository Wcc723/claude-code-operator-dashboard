import { config as dotenvConfig } from 'dotenv';
import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_boot = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname_boot, '../../../.env') });

import { openDb } from './db/index.js';
import { ChannelReader } from './services/channel-reader.js';
import { KanbanRepo } from './services/kanban-repo.js';
import { AuthGate } from './services/auth-gate.js';
import { LaunchProfileRepo } from './services/launch-profile-repo.js';
import { TerminalManager } from './services/terminal-manager.js';
import { SessionInsights } from './services/session-insights.js';
import { resolveStatusDir } from './services/status-paths.js';
import { SystemSampler } from './services/system-stats.js';
import { ClaudeAccounts } from './services/claude-accounts.js';
import { CodexAccounts } from './services/codex-accounts.js';
import { McpTokens } from './services/mcp-tokens.js';
import { ArtifactRepo } from './services/artifact-repo.js';
import { ArtifactNotifier } from './services/artifact-notifier.js';

import { authRouter } from './routes/auth.js';
import { skillsRouter } from './routes/skills.js';
import { agentsRouter } from './routes/agents.js';
import { tasksRouter } from './routes/tasks.js';
import { memoryRouter } from './routes/memory.js';
import { kanbanRouter } from './routes/kanban.js';
import { identityRouter } from './routes/identity.js';
import { statusRouter } from './routes/status.js';
import { launchProfilesRouter } from './routes/launch-profiles.js';
import { sessionsRouter } from './routes/sessions.js';
import { systemRouter } from './routes/system.js';
import { setupRouter } from './routes/setup.js';
import { accountsRouter } from './routes/accounts.js';
import { artifactsRouter } from './routes/artifacts.js';
import { mcpRouter } from './routes/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProd = process.env.NODE_ENV === 'production';

const dbPath = process.env.KANBAN_DB_PATH ?? resolve(__dirname, '../data/kanban.db');
const db = openDb(dbPath);
// session log 與 artifact MCP 設定檔的目錄；CODD_DATA_DIR 給測試用（DB 位置仍看 KANBAN_DB_PATH）
const dataDir = process.env.CODD_DATA_DIR ? resolve(process.env.CODD_DATA_DIR) : resolve(__dirname, '../data');

// 對外網址（artifact 連結用）：CODD_PUBLIC_URL > https://TUNNEL_HOSTNAME > 本機
const publicUrl = (process.env.CODD_PUBLIC_URL
  || (process.env.TUNNEL_HOSTNAME ? `https://${process.env.TUNNEL_HOSTNAME}` : `http://localhost:${PORT}`)
).replace(/\/+$/, '');

// CODD 開的 Claude session 自動掛上 artifact MCP（CODD_ARTIFACTS_MCP=0 關掉，spawn 行為跟以前完全一樣）。
// 建不起來（例如 data 目錄不能寫）就只是沒有 artifact 工具，server 照常啟動
let mcpTokens = null;
if (process.env.CODD_ARTIFACTS_MCP !== '0') {
  try {
    // CODD_ARTIFACTS_AUTO_ALLOW=0：不帶 --settings，artifact 工具照 Claude Code 的權限設定問使用者
    mcpTokens = new McpTokens({ dataDir, port: PORT, host: HOST, autoAllow: process.env.CODD_ARTIFACTS_AUTO_ALLOW !== '0' });
    mcpTokens.cleanupStale();
    // 自動允許 mcp__codd-artifacts 的權限設定檔（固定內容、不含 token；spawn 時也會再確認一次）
    try { mcpTokens.ensureSettings(); } catch (e) {
      console.error('[codd-server] artifact MCP settings not written:', e?.code || e?.message);
    }
    // host token（<dataDir>/mcp-host-token，0600）：給不是 CODD 開的 Claude session 手動掛 MCP 用。
    // 啟動時就建好，文件才能直接叫人 `cat` 它；刪掉檔案 = 撤銷，下次啟動換新的
    mcpTokens.hostToken();
  } catch (e) {
    console.error('[codd-server] artifact MCP disabled:', e?.code || e?.message);
    mcpTokens = null;
  }
}

const reader = new ChannelReader(process.env.CHANNEL_PATH);
const repo = new KanbanRepo(db);
const profileRepo = new LaunchProfileRepo(db);
const terminal = new TerminalManager({
  profiles: profileRepo,
  logDir: join(dataDir, 'sessions'),
  mcp: mcpTokens,
});
const statusDir = resolveStatusDir();
const insights = new SessionInsights({ statusDir });
const artifactMaxBytes = Number(process.env.CODD_ARTIFACT_MAX_BYTES);
const artifactRepo = new ArtifactRepo(db, {
  maxContentBytes: Number.isFinite(artifactMaxBytes) && artifactMaxBytes > 0 ? artifactMaxBytes : undefined,
});
// 通知只在 session 明確閒置（hook / registry 回報 idle）時打進終端機；CODD_ARTIFACT_NOTIFY_UNKNOWN=1 才在狀態不明時也送
const notifier = new ArtifactNotifier({
  terminal, insights, repo: artifactRepo,
  notifyOnUnknown: process.env.CODD_ARTIFACT_NOTIFY_UNKNOWN === '1',
});
const sampler = new SystemSampler({ terminal });
// 帳號切換：Claude 走 cswap、Codex 走 codex app-server + 本機帳號庫（CSWAP_BIN / CODEX_BIN / CODEX_HOME / CODD_CODEX_VAULT）
const claudeAccounts = new ClaudeAccounts();
const codexAccounts = new CodexAccounts();
const authGate = new AuthGate({
  clientId: process.env.GOOGLE_CLIENT_ID,
  allowedEmail: process.env.ALLOWED_EMAIL,
  sessionSecret: process.env.SESSION_SECRET,
  db,
  ttlDays: Number(process.env.SESSION_TTL_DAYS ?? 7),
  isProd,
});

const app = express();
app.disable('x-powered-by');
// /api/mcp 有自己的 body parser（上限比較大，artifact HTML 可能好幾 MB）
const jsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.path === '/api/mcp' || req.path.startsWith('/api/mcp/')) return next();
  jsonParser(req, res, next);
});
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // cloudflareinsights：Cloudflare 對所有 zone 強制注入的 Web Analytics beacon；
      // 免費方案無法從 dashboard 完全停用，直接在 CSP 放行避免 console 噪音
      "script-src 'self' https://accounts.google.com https://static.cloudflareinsights.com",
      // 'self'：artifact 在同源的 sandbox iframe 裡顯示（/api/artifacts/:id/v/:n/frame/:frameId）
      "frame-src 'self' https://accounts.google.com",
      "connect-src 'self' https://accounts.google.com https://cloudflareinsights.com",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter(authGate));

const protect = authGate.middleware();
app.use('/api/skills', protect, skillsRouter(reader));
app.use('/api/agents', protect, agentsRouter(reader));
app.use('/api/tasks', protect, tasksRouter(reader));
app.use('/api/memory', protect, memoryRouter(reader));
app.use('/api/kanban', protect, kanbanRouter(repo));
app.use('/api/identity', protect, identityRouter(reader));
app.use('/api/status', protect, statusRouter(terminal, insights));
app.use('/api/launch-profiles', protect, launchProfilesRouter(profileRepo));
app.use('/api/terminal/sessions', protect, sessionsRouter(terminal, insights));
app.use('/api/system', protect, systemRouter(sampler, insights));
app.use('/api/setup', protect, setupRouter({ statusDir, repoRoot: resolve(__dirname, '../../..') }));
app.use('/api/accounts', protect, accountsRouter({ claude: claudeAccounts, codex: codexAccounts }));
app.use('/api/artifacts', protect, artifactsRouter({ repo: artifactRepo, notifier, terminal, insights }));
// MCP 不經過 protect（Claude Code 沒有登入 cookie）：用 per-session bearer token，且只接受本機直連
if (mcpTokens) app.use('/api/mcp', mcpRouter({ tokens: mcpTokens, repo: artifactRepo, terminal, insights, publicUrl }));

if (isProd) {
  const distPath = resolve(__dirname, '../../web/dist');
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
      res.sendFile(join(distPath, 'index.html'));
    });
  }
}

app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (isProd) {
    console.error('[error]', err.message);
  } else {
    console.error('[error]', err);
  }
  // 4xx 是 user-induced（CONFLICT / NOT_FOUND / validation），訊息對 user 有用
  // 5xx 在 prod 一律遮罩，避免洩漏絕對路徑 / SQL column 名 / internal 字串
  const body = (isProd && status >= 500)
    ? { error: 'internal error' }
    : { error: err.message ?? 'internal error' };
  res.status(status).json(body);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[codd-server] listening on http://${HOST}:${PORT}`);
  console.log(`[codd-server] channel: ${reader.root}`);
  console.log(`[codd-server] db: ${resolve(dbPath)}`);
  console.log(`[codd-server] status dir: ${statusDir}`);
  console.log(`[codd-server] artifacts: ${publicUrl}/artifacts（MCP ${mcpTokens ? 'on' : 'off'}）`);
});

// 讓 keep-alive 連線立刻收到 FIN 而不是等到 idle，避免 port 卡 TIME_WAIT
server.keepAliveTimeout = 1000;
server.headersTimeout = 2000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[codd-server] ${signal} received, shutting down…`);

  // 0. Hard timeout 兜底：12s（足以涵蓋 PTY SIGTERM 5s + SIGKILL 2s + 緩衝）
  setTimeout(() => {
    console.error('[codd-server] forced exit (shutdown timeout)');
    process.exit(1);
  }, 12000).unref();

  sampler.stop();
  // 還在等 session 閒置的 artifact 通知不再送（DB 留 pending，下次啟動改成 no_session）
  notifier.stop();
  // cswap / codex app-server 子行程：codex 探測用的暫存 CODEX_HOME 裡有 token，要等它清完（stop 自己最多等 4 s）
  claudeAccounts.stop();
  const accountsStopped = codexAccounts.stop().catch(() => {});

  // 1. HTTP server：停接新連線、強制斷現有 keep-alive；同時 await 真的關閉
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  const httpClosed = new Promise(r => server.close(() => r()));

  // 2. PTY：SIGTERM → 5s graceful → SIGKILL → 2s reap，await 全部死乾淨
  let killErr;
  try {
    await terminal.killAll();
    console.log('[codd-server] all PTY children terminated');
  } catch (e) {
    killErr = e;
  }

  // 3. 等 HTTP 完全關掉再關 DB（PTY 在 onExit 會 logStream.end()，先讓它寫完）
  await httpClosed;
  await accountsStopped;
  try { db.close(); } catch {}

  if (killErr) console.error('[codd-server] killAll error', killErr);
  console.log('[codd-server] closed cleanly');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGHUP', () => { shutdown('SIGHUP'); });

export { db, reader, repo, authGate };
