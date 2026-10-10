import { Router } from 'express';
import { pullQuerySchema, pushRequestSchema, uuidSchema } from '@serverdeck/shared';
import type { AppContext } from '../context';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { parse } from '../middleware/validate';
import type { SyncService } from '../services/sync';

export function syncRouter(ctx: AppContext, sync: SyncService): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/pull', async (req, res) => {
    const { since, limit } = parse(pullQuerySchema, req.query);
    res.json(await sync.pull(currentUserId(res), since, limit));
  });

  router.post('/push', async (req, res) => {
    const { changes } = parse(pushRequestSchema, req.body);
    res.json({ results: await sync.push(currentUserId(res), changes) });
  });

  return router;
}

export function serversRouter(ctx: AppContext, sync: SyncService): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/trash', async (_req, res) => {
    res.json({ servers: await sync.listTrash(currentUserId(res)) });
  });

  router.post('/:id/restore', async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    res.json(await sync.restoreFromTrash(currentUserId(res), id));
  });

  router.get('/history', async (_req, res) => {
    res.json({ entries: await sync.listHistory(currentUserId(res)) });
  });

  router.post('/history/:historyId/restore', async (req, res) => {
    const historyId = parse(uuidSchema, req.params.historyId);
    res.json(await sync.restoreFromHistory(currentUserId(res), historyId));
  });

  return router;
}
