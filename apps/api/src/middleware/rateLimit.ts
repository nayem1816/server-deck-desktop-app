import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../lib/errors';

interface LimiterOptions {
  windowMinutes: number;
  limit: number;
  /** Count per IP + email instead of per IP (spec section 7). */
  byEmail: boolean;
}

function emailFrom(req: Request): string {
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** In-memory store; fine for a single API instance (D-010). */
export function createLimiter({ windowMinutes, limit, byEmail }: LimiterOptions) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (byEmail ? `${req.ip}|${emailFrom(req)}` : (req.ip ?? 'unknown')),
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          `Too many attempts. Wait ${windowMinutes} minutes and try again.`,
        ),
      );
    },
  });
}
