import { Router } from 'express';

export function launchProfilesRouter(repo) {
  const router = Router();

  router.get('/', (req, res) => res.json({ items: repo.list() }));

  router.get('/:id', (req, res) => {
    const item = repo.get(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(item);
  });

  router.post('/', (req, res, next) => {
    try { res.status(201).json(repo.create(req.body ?? {})); }
    catch (e) { res.status(e.status ?? 500).json({ error: e.message }); }
  });

  // repo.update 會 throw 400（color / 必填欄位不合法）與 409（name 撞名），要原樣回給前端
  router.patch('/:id', (req, res) => {
    try {
      const updated = repo.update(Number(req.params.id), req.body ?? {});
      if (!updated) return res.status(404).json({ error: 'not found' });
      res.json(updated);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  router.delete('/:id', (req, res) => {
    const ok = repo.delete(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return router;
}
