import { Router } from 'express';
import { enrichList } from './sessions.js';

// 舊版 Pulse 用的相容端點：資料源 = app 自己 spawn 的 PTY sessions，
// 狀態（last_tool / idle）一律從 SessionInsights 來，不再自己讀 codd-status 目錄。
const STALE_AFTER_SEC = 60 * 60;

function runtimeSeconds(s) {
  const start = s.started_at ? Date.parse(s.started_at) : null;
  if (!start) return null;
  const end = s.exited_at ? Date.parse(s.exited_at) : Date.now();
  return Math.max(0, Math.floor((end - start) / 1000));
}

// 只有「閒著 / 等你」才算 idle 秒數；busy 時沒意義
function idleSeconds(activity) {
  if (!activity || !['idle', 'waiting'].includes(activity.state)) return null;
  const since = activity.since ? Date.parse(activity.since) : NaN;
  if (!Number.isFinite(since)) return null;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

export function statusRouter(terminal, insights) {
  const router = Router();

  router.get('/', async (req, res) => {
    // 只顯示「活著的」session：running 且未被移除
    const sessions = terminal.list().filter(s => s.status === 'running' && !s.removed);
    const enriched = await enrichList(insights, sessions);
    const items = enriched
      .map(s => {
        const idle = idleSeconds(s.activity);
        return {
          session_id: s.id,
          profile_name: s.profile_name,
          status: s.status,
          runtime_seconds: runtimeSeconds(s),
          last_tool: s.activity?.last_tool ?? null,
          idle_seconds: idle,
          tool_count: s.activity?.tool_count ?? null,
          stale: idle !== null && idle > STALE_AFTER_SEC,
        };
      })
      // 執行最久的排前面（穩定 session 置頂）
      .sort((a, b) => (b.runtime_seconds ?? 0) - (a.runtime_seconds ?? 0));
    res.json({ available: true, items });
  });

  return router;
}
