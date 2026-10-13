import { Router } from 'express';

// 側欄底部的主機狀態 + 目前帳號的 5h/1w 用量。
// sampler 是 lazy 的：這個 route 被打到才開始取樣，沒人看 60 s 後自動停。
export function systemRouter(sampler, insights) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      sampler.touch();
      // 冷啟動那一次等第一輪取樣（最多 ~2 s），避免回一包全是 null 的 snapshot
      await sampler.ready();
      let usage = null;
      try {
        usage = await insights.readUsage();
      } catch {
        usage = null;
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ...sampler.snapshot(), usage });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
