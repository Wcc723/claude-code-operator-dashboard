import { Router } from 'express';
import {
  getSetupStatus,
  planSetup,
  planUninstall,
  applySetup,
  uninstallSetup,
  parseParts,
} from '../services/claude-setup.js';

// 引導式安裝：只改 server 這台機器上的 ~/.claude/settings.json（hooks + statusLine），
// 回應只帶被動到的子樹，不回整份 settings。
export function setupRouter(opts = {}) {
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res) => {
    respond(res, () => getSetupStatus(opts));
  });

  // GET /plan?parts=hooks,statusline[&action=uninstall]
  router.get('/plan', (req, res) => {
    respond(res, () => {
      const parts = parseParts(req.query.parts);
      return req.query.action === 'uninstall' ? planUninstall(parts, opts) : planSetup(parts, opts);
    });
  });

  router.post('/apply', (req, res) => {
    respond(res, () => applySetup(parseParts(req.body?.parts, { required: true }), opts));
  });

  router.post('/uninstall', (req, res) => {
    respond(res, () => uninstallSetup(parseParts(req.body?.parts, { required: true }), opts));
  });

  return router;
}

function respond(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) console.error('[setup]', e.code || '', e.message);
    res.status(status).json({ error: e.message || 'setup failed' });
  }
}
