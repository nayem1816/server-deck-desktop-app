import { Router } from 'express';
import {
  changePasswordRequestSchema,
  deleteMeRequestSchema,
  updateMeRequestSchema,
} from '@serverdeck/shared';
import type { AppContext } from '../context';
import { createLimiter } from '../middleware/rateLimit';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { parse } from '../middleware/validate';
import { createUserService } from '../services/users';

export function meRouter(ctx: AppContext): Router {
  const router = Router();
  const users = createUserService(ctx);
  // Endpoints that check the current password get the same brute-force limit as login.
  const reauthLimiter = createLimiter({
    windowMinutes: 15,
    limit: ctx.config.AUTH_RATE_LIMIT,
    byEmail: false,
  });

  router.use(requireAuth(ctx));

  router.get('/', async (_req, res) => {
    res.json(await users.getMe(currentUserId(res)));
  });

  router.patch('/', reauthLimiter, async (req, res) => {
    res.json(await users.updateMe(currentUserId(res), parse(updateMeRequestSchema, req.body)));
  });

  router.post('/password', reauthLimiter, async (req, res) => {
    const input = parse(changePasswordRequestSchema, req.body);
    res.json(await users.changePassword(currentUserId(res), input));
  });

  router.delete('/', reauthLimiter, async (req, res) => {
    const { authKey } = parse(deleteMeRequestSchema, req.body);
    await users.deleteMe(currentUserId(res), authKey);
    res.status(204).end();
  });

  return router;
}
