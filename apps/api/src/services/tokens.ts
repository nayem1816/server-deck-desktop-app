import { randomUUID } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { ClientSession } from 'mongoose';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS, type Config } from '../config';
import { AppError, unauthorized } from '../lib/errors';
import { generateOpaqueToken, sha256 } from '../lib/crypto';
import { RefreshToken, User } from '../models';

const ISSUER = 'serverdeck-api';

export interface AccessClaims {
  userId: string;
  tokenVersion: number;
}

export function createTokenService(config: Pick<Config, 'JWT_SECRET'>) {
  const key = new TextEncoder().encode(config.JWT_SECRET);

  async function signAccessToken(userId: string, tokenVersion: number): Promise<string> {
    return new SignJWT({ tv: tokenVersion })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(key);
  }

  async function verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.tv !== 'number') throw unauthorized();
      return { userId: payload.sub, tokenVersion: payload.tv };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Session expired');
      }
      throw unauthorized();
    }
  }

  async function issueRefreshToken(
    userId: string,
    deviceName: string,
    familyId: string = randomUUID(),
    session?: ClientSession,
  ): Promise<string> {
    const token = generateOpaqueToken();
    await RefreshToken.create(
      [
        {
          userId,
          familyId,
          deviceName,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
        },
      ],
      { session },
    );
    return token;
  }

  async function issueTokens(
    user: { _id: string; tokenVersion: number },
    deviceName: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(user._id, user.tokenVersion),
      issueRefreshToken(user._id, deviceName),
    ]);
    return { accessToken, refreshToken };
  }

  /** Single-use rotation. Presenting an already-rotated token revokes its whole family (D-007). */
  async function rotateRefreshToken(token: string) {
    const tokenHash = sha256(token);
    const now = new Date();
    const current = await RefreshToken.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { revokedAt: now },
    ).lean();

    if (!current) {
      const known = await RefreshToken.findOne({ tokenHash }).lean();
      if (known?.revokedAt) {
        await RefreshToken.updateMany(
          { familyId: known.familyId, revokedAt: null },
          { revokedAt: now },
        );
        throw new AppError(401, 'TOKEN_REUSED', 'Session was used elsewhere. Please log in again.');
      }
      throw unauthorized();
    }

    const user = await User.findById(current.userId, { tokenVersion: 1 }).lean();
    if (!user) throw unauthorized();

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(user._id, user.tokenVersion),
      issueRefreshToken(user._id, current.deviceName, current.familyId),
    ]);
    return { accessToken, refreshToken };
  }

  async function revokeRefreshToken(token: string): Promise<void> {
    await RefreshToken.updateOne(
      { tokenHash: sha256(token), revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  async function revokeAllRefreshTokens(userId: string, session?: ClientSession): Promise<void> {
    await RefreshToken.updateMany(
      { userId, revokedAt: null },
      { revokedAt: new Date() },
      { session },
    );
  }

  return {
    signAccessToken,
    verifyAccessToken,
    issueTokens,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
