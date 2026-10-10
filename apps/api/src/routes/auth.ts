import { Router } from 'express';
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  preloginRequestSchema,
  refreshRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  verifyResetCodeRequestSchema,
} from '@serverdeck/shared';
import type { AppContext } from '../context';
import { createLimiter } from '../middleware/rateLimit';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { parse } from '../middleware/validate';
import { createAuthService } from '../services/auth';

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = createAuthService(ctx);
  const limit = ctx.config.AUTH_RATE_LIMIT;
  const loginLimiter = createLimiter({ windowMinutes: 15, limit, byEmail: true });
  const resetLimiter = createLimiter({ windowMinutes: 15, limit, byEmail: true });
  const signupLimiter = createLimiter({ windowMinutes: 60, limit, byEmail: false });

  router.post('/prelogin', async (req, res) => {
    const { email } = parse(preloginRequestSchema, req.body);
    res.json(await auth.prelogin(email));
  });

  router.post('/signup', signupLimiter, async (req, res) => {
    res.status(201).json(await auth.signup(parse(signupRequestSchema, req.body)));
  });

  router.post('/login', loginLimiter, async (req, res) => {
    res.json(await auth.login(parse(loginRequestSchema, req.body)));
  });

  router.post('/refresh', async (req, res) => {
    const { refreshToken } = parse(refreshRequestSchema, req.body);
    res.json(await auth.refresh(refreshToken));
  });

  router.post('/logout', async (req, res) => {
    const { refreshToken } = parse(logoutRequestSchema, req.body);
    await auth.logout(refreshToken);
    res.status(204).end();
  });

  router.post('/logout-all', requireAuth(ctx), async (_req, res) => {
    await auth.logoutAll(currentUserId(res));
    res.status(204).end();
  });

  router.post('/forgot-password', resetLimiter, async (req, res) => {
    const { email } = parse(forgotPasswordRequestSchema, req.body);
    await auth.forgotPassword(email);
    res.status(204).end();
  });

  router.post('/reset-password/verify', resetLimiter, async (req, res) => {
    const { email, code } = parse(verifyResetCodeRequestSchema, req.body);
    res.json(await auth.verifyResetCode(email, code));
  });

  router.post('/reset-password', async (req, res) => {
    await auth.resetPassword(parse(resetPasswordRequestSchema, req.body));
    res.status(204).end();
  });

  return router;
}
