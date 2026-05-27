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
import { tracePlatformInfo, tracePtyBinding, startLagMonitor, requestTraceMiddleware, tlog } from './services/trace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProd = process.env.NODE_ENV === 'production';

const dbPath = process.env.KANBAN_DB_PATH ?? resolve(__dirname, '../data/kanban.db');
const db = openDb(dbPath);

const reader = new ChannelReader(process.env.CHANNEL_PATH);
const repo = new KanbanRepo(db);
const profileRepo = new LaunchProfileRepo(db);
const terminal = new TerminalManager({
  profiles: profileRepo,
  logDir: resolve(__dirname, '../data/sessions'),
});
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
// 效能追蹤：印每個 request 進入 / 完成 / 耗時。第一個 middleware 才能涵蓋全部
app.use(requestTraceMiddleware);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com",
      "frame-src https://accounts.google.com",
      "connect-src 'self' https://accounts.google.com",
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
app.use('/api/status', protect, statusRouter());
app.use('/api/launch-profiles', protect, launchProfilesRouter(profileRepo));
app.use('/api/terminal/sessions', protect, sessionsRouter(terminal));

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

const server = app.listen(PORT, HOST, async () => {
  console.log(`[codd-server] listening on http://${HOST}:${PORT}`);
  console.log(`[codd-server] channel: ${reader.root}`);
  console.log(`[codd-server] db: ${resolve(dbPath)}`);
  // 效能追蹤啟動
  tracePlatformInfo({ port: PORT, host: HOST, channelPath: reader.root });
  await tracePtyBinding();
  startLagMonitor();
  tlog('boot', 'trace ready — 用 CODD_TRACE=0 可關閉');
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
  try { db.close(); } catch {}

  if (killErr) console.error('[codd-server] killAll error', killErr);
  console.log('[codd-server] closed cleanly');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGHUP', () => { shutdown('SIGHUP'); });

export { db, reader, repo, authGate };
