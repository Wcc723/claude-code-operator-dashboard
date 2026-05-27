// 效能追蹤工具：用於診斷 Mac mini 卡頓 root cause。
//
// 用 CODD_TRACE=0 env var 可整個關掉（預設 on）。
// 所有 trace 印到 stderr，避免跟 stdout 應用 log 混淆。
// 篩選：tail -f server.log | grep '\[trace'

import { performance } from 'node:perf_hooks';

const enabled = process.env.CODD_TRACE !== '0';

function ts() {
  return new Date().toISOString().slice(11, 23);
}

export function tlog(scope, msg, extra) {
  if (!enabled) return;
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`[trace ${ts()}] [${scope}] ${msg}${tail}\n`);
}

// 用法：const T = tstart('listAgents'); ...work...; T.end({ n: 9 });
export function tstart(scope) {
  const start = performance.now();
  return {
    end(extra) {
      const ms = (performance.now() - start).toFixed(1);
      tlog(scope, `done in ${ms}ms`, extra);
    },
    elapsed() {
      return performance.now() - start;
    },
  };
}

// Event loop lag monitor —— 每秒檢查 setInterval 跟預期間隔的差距。
// 如果 event loop 被 sync code 卡住（PTY callback 太密、GC 等），
// setInterval 不會準時觸發，下次觸發時 (now - last - 1000) 就會 > 0。
// 卡頓越嚴重數值越大。> 100ms = 明顯卡。
let lagInterval;
export function startLagMonitor() {
  if (lagInterval || !enabled) return;
  let last = performance.now();
  lagInterval = setInterval(() => {
    const now = performance.now();
    const lag = now - last - 1000;
    if (lag > 50) {
      tlog('lag', `⚠️  event loop lagged ${lag.toFixed(0)}ms (expected ~0)`);
    }
    last = now;
  }, 1000);
  lagInterval.unref();
  tlog('boot', 'event loop lag monitor started');
}

// PTY onData chunk 頻率 / 流量統計，每 2 秒印一次摘要。
// 看 Mac mini 上 claude TUI 啟動瞬間到底有多大 throughput。
const ptyStats = new Map();
export function recordPtyChunk(id, bytes) {
  if (!enabled) return;
  let s = ptyStats.get(id);
  if (!s) {
    s = { count: 0, bytes: 0, lastReport: Date.now(), startedAt: Date.now() };
    ptyStats.set(id, s);
  }
  s.count++;
  s.bytes += bytes;
  const now = Date.now();
  if (now - s.lastReport >= 2000) {
    const sec = (now - s.lastReport) / 1000;
    tlog('pty', `${id.slice(0, 8)} chunks=${s.count}/${sec.toFixed(0)}s rate=${(s.count / sec).toFixed(0)}/s throughput=${(s.bytes / sec / 1024).toFixed(1)}KB/s`);
    s.count = 0;
    s.bytes = 0;
    s.lastReport = now;
  }
}

export function endPtyStats(id) {
  if (!enabled) return;
  const s = ptyStats.get(id);
  if (s) {
    const lifeSec = (Date.now() - s.startedAt) / 1000;
    tlog('pty', `${id.slice(0, 8)} ended after ${lifeSec.toFixed(1)}s`);
    ptyStats.delete(id);
  }
}

// Express middleware：印每個 API request 進入 / 完成 / 耗時。
// 用來看「卡頓當下」哪些 request 正在跑、哪個沒回。
export function requestTraceMiddleware(req, res, next) {
  if (!enabled) return next();
  const start = performance.now();
  const tag = `${req.method} ${req.url}`;
  tlog('req', `→ ${tag}`);
  res.on('finish', () => {
    const ms = (performance.now() - start).toFixed(0);
    tlog('req', `← ${tag} ${res.statusCode} ${ms}ms`);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      const ms = (performance.now() - start).toFixed(0);
      tlog('req', `✗ ${tag} closed-before-end after ${ms}ms`);
    }
  });
  next();
}

// 啟動時印環境資訊：找出 Mac mini vs 本機差異
export function tracePlatformInfo({ port, host, channelPath }) {
  if (!enabled) return;
  tlog('boot', '═══════ environment ═══════');
  tlog('boot', `node       ${process.version} ${process.platform}/${process.arch}`);
  tlog('boot', `pid        ${process.pid}`);
  tlog('boot', `cwd        ${process.cwd()}`);
  tlog('boot', `listen     ${host}:${port}`);
  tlog('boot', `channel    ${channelPath}`);
  tlog('boot', `NODE_ENV   ${process.env.NODE_ENV ?? '(unset)'}`);
  const mem = process.memoryUsage();
  tlog('boot', `rss ${(mem.rss / 1024 / 1024).toFixed(0)}MB heap ${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`);
}

// PTY native binding 是否載入成功的 sanity check
export async function tracePtyBinding() {
  if (!enabled) return;
  try {
    const ptyMod = await import('@homebridge/node-pty-prebuilt-multiarch');
    const has = typeof ptyMod.default?.spawn === 'function' || typeof ptyMod.spawn === 'function';
    tlog('boot', `pty binding loaded=${has}`);
  } catch (e) {
    tlog('boot', `pty binding FAILED: ${e.message}`);
  }
}
