import { Router } from 'express';

// 側欄用量面板的帳號切換：Claude（cswap 包裝）與 Codex（app-server 探測 + 本機帳號庫）。
// GET 永遠回 200：工具沒裝 / 壞掉時是 available:false + error，前端照樣能畫退路。
// 會動到憑證的操作（switch / save / rename / remove）錯誤照 err.status 回（400 / 404 / 409 / 502 / 503）。
export function accountsRouter({ claude, codex }) {
  const router = Router();

  const wantRefresh = (req) => req.query.refresh === '1' || req.query.refresh === 'true';

  const send = (res, body, status = 200) => {
    res.set('Cache-Control', 'no-store');
    res.status(status).json(body);
  };

  // 帶 status 的是我們丟的（訊息是給使用者看的繁中短句）；其他交給全域 error handler（prod 會遮 5xx）
  const fail = (res, next, e) => {
    if (e?.status) return send(res, { error: e.message }, e.status);
    next(e);
  };

  const fallback = (provider) => ({
    available: false,
    error: `讀取 ${provider} 帳號時發生錯誤`,
    version: null,
    fetched_at: new Date().toISOString(),
    accounts: [],
  });

  router.get('/claude', async (req, res) => {
    try {
      send(res, await claude.get({ refresh: wantRefresh(req) }));
    } catch (e) {
      console.error('[accounts] claude list failed:', e?.message);
      send(res, { ...fallback('Claude'), active_number: null });
    }
  });

  router.post('/claude/switch', async (req, res, next) => {
    try {
      send(res, await claude.switch(req.body?.number));
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.get('/codex', async (req, res) => {
    try {
      send(res, await codex.get({ refresh: wantRefresh(req) }));
    } catch (e) {
      console.error('[accounts] codex list failed:', e?.message);
      send(res, { ...fallback('Codex'), can_switch: false, active_id: null });
    }
  });

  router.post('/codex/save-current', async (req, res, next) => {
    try {
      send(res, await codex.saveCurrent(req.body?.label));
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.post('/codex/switch', async (req, res, next) => {
    try {
      send(res, await codex.switchTo(req.body?.id));
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.patch('/codex/:id', async (req, res, next) => {
    try {
      send(res, await codex.rename(req.params.id, req.body?.label));
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.delete('/codex/:id', async (req, res, next) => {
    try {
      send(res, await codex.remove(req.params.id));
    } catch (e) {
      fail(res, next, e);
    }
  });

  return router;
}
