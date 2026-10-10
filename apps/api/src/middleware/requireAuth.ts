import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context';
import { unauthorized } from '../lib/errors';
import { User } from '../models';

/** Verifies the bearer token and checks it against the user's current tokenVersion (D-008). */
export function requireAuth(ctx: AppContext) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    const claims = await ctx.tokens.verifyAccessToken(header.slice('Bearer '.length));
    const user = await User.findById(claims.userId, { tokenVersion: 1 }).lean();
    if (!user || user.tokenVersion !== claims.tokenVersion) throw unauthorized();

    res.locals.userId = user._id;
    next();
  };
}

/** The authenticated user's id. Only valid behind requireAuth. */
export function currentUserId(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== 'string') throw unauthorized();
  return userId;
}
