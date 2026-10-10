import mongoose from 'mongoose';
import {
  DEFAULT_KDF_PARAMS,
  type AuthResponse,
  type LoginRequest,
  type PreloginResponse,
  type ResetPasswordRequest,
  type SignupRequest,
  type VerifyResetCodeResponse,
} from '@serverdeck/shared';
import { RESET_CODE_MAX_ATTEMPTS, RESET_CODE_TTL_MINUTES } from '../config';
import type { AppContext } from '../context';
import {
  burnVerifyTime,
  generateOpaqueToken,
  generateResetCode,
  hashAuthKey,
  hmac,
  safeEqualHex,
  sha256,
  verifyAuthKey,
} from '../lib/crypto';
import { AppError, invalidCredentials } from '../lib/errors';
import { PasswordReset, RefreshToken, Server, ServerHistory, User, type UserDoc } from '../models';
import { nextSyncSeq, toPublicUser, toVaultInfo } from './mappers';

const invalidCode = () =>
  new AppError(400, 'INVALID_CODE', 'The code is wrong or has expired. Request a new code.');

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export function createAuthService(ctx: AppContext) {
  const { config, tokens, mailer, logger } = ctx;

  async function authResponse(user: UserDoc, deviceName: string): Promise<AuthResponse> {
    const issued = await tokens.issueTokens(user, deviceName);
    return { ...issued, user: toPublicUser(user), vault: toVaultInfo(user) };
  }

  function resetCodeHash(resetId: string, code: string): string {
    return hmac(config.SERVER_SECRET, `reset:${resetId}:${code}`).toString('hex');
  }

  return {
    /** Returns the KDF salt, or a stable fake one for unknown emails (D-003). */
    async prelogin(email: string): Promise<PreloginResponse> {
      const user = await User.findOne({ email }, { kdfSalt: 1, kdfParams: 1 }).lean();
      if (user) return { kdfSalt: user.kdfSalt, kdfParams: toVaultInfo(user).kdfParams };
      const fakeSalt = hmac(config.SERVER_SECRET, `prelogin:${email}`).subarray(0, 16);
      return { kdfSalt: fakeSalt.toString('base64'), kdfParams: DEFAULT_KDF_PARAMS };
    },

    async signup(input: SignupRequest): Promise<AuthResponse> {
      if (await User.exists({ email: input.email })) {
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      try {
        const user = await User.create({
          name: input.name,
          email: input.email,
          authHash: await hashAuthKey(input.authKey),
          kdfSalt: input.kdfSalt,
          kdfParams: input.kdfParams,
          vaultKeyWrapped: input.vaultKeyWrapped,
          vaultKeyRecovery: input.vaultKeyRecovery,
        });
        return await authResponse(user.toObject(), input.deviceName);
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw err;
      }
    },

    async login(input: LoginRequest): Promise<AuthResponse> {
      const user = await User.findOne({ email: input.email }).lean();
      if (!user) {
        await burnVerifyTime(input.authKey);
        throw invalidCredentials();
      }
      if (!(await verifyAuthKey(user.authHash, input.authKey))) throw invalidCredentials();
      return authResponse(user, input.deviceName);
    },

    refresh: tokens.rotateRefreshToken,
    logout: tokens.revokeRefreshToken,

    async logoutAll(userId: string): Promise<void> {
      await RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
      await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    },

    /** Always succeeds so the response doesn't reveal whether the email exists. */
    async forgotPassword(email: string): Promise<void> {
      const user = await User.findOne({ email }, { _id: 1 }).lean();
      if (!user) return;

      const now = new Date();
      await PasswordReset.updateMany({ userId: user._id, usedAt: null }, { usedAt: now });

      const code = generateResetCode();
      const reset = new PasswordReset({
        userId: user._id,
        codeHash: '',
        expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MINUTES * 60_000),
      });
      reset.codeHash = resetCodeHash(reset._id, code);
      await reset.save();

      // Not awaited: response time must not depend on the mail server.
      mailer.sendResetCode(email, code).catch((err: unknown) => {
        logger.error({ err }, 'Failed to send password reset email');
      });
    },

    async verifyResetCode(email: string, code: string): Promise<VerifyResetCodeResponse> {
      const user = await User.findOne({ email }, { vaultKeyRecovery: 1 }).lean();
      if (!user) throw invalidCode();

      const now = new Date();
      // Count the attempt before comparing, atomically, so parallel guesses can't exceed the cap.
      const reset = await PasswordReset.findOneAndUpdate(
        {
          userId: user._id,
          usedAt: null,
          verifiedAt: null,
          expiresAt: { $gt: now },
          attempts: { $lt: RESET_CODE_MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
        { sort: { createdAt: -1 }, new: true },
      ).lean();
      if (!reset || !safeEqualHex(reset.codeHash, resetCodeHash(reset._id, code))) {
        throw invalidCode();
      }

      const resetToken = generateOpaqueToken();
      await PasswordReset.updateOne(
        { _id: reset._id },
        {
          verifiedAt: now,
          resetTokenHash: sha256(resetToken),
          expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MINUTES * 60_000),
        },
      );
      return { resetToken, vaultKeyRecovery: user.vaultKeyRecovery };
    },

    /** D-004 / D-005. */
    async resetPassword(input: ResetPasswordRequest): Promise<void> {
      const authHash = await hashAuthKey(input.newAuthKey);
      const now = new Date();

      await mongoose.connection.transaction(async (session) => {
        const reset = await PasswordReset.findOneAndUpdate(
          {
            resetTokenHash: sha256(input.resetToken),
            verifiedAt: { $ne: null },
            usedAt: null,
            expiresAt: { $gt: now },
          },
          { usedAt: now },
          { session },
        ).lean();
        if (!reset) throw invalidCode();

        const inc: Record<string, number> = { tokenVersion: 1 };
        const set: Record<string, unknown> = {
          authHash,
          kdfSalt: input.newKdfSalt,
          kdfParams: input.newKdfParams,
          vaultKeyWrapped: input.newVaultKeyWrapped,
        };

        if (input.secretsReset) {
          set.vaultKeyRecovery = input.newVaultKeyRecovery;
          inc.vaultKeyVersion = 1;
          const seq = await nextSyncSeq(reset.userId, session);
          await Server.updateMany(
            {
              userId: reset.userId,
              $or: [{ secretEnc: { $ne: null } }, { passphraseEnc: { $ne: null } }],
            },
            { $set: { secretEnc: null, passphraseEnc: null, seq }, $inc: { version: 1 } },
            { session },
          );
          // Old snapshots were encrypted with the replaced vault key too.
          await ServerHistory.updateMany(
            { userId: reset.userId },
            { $set: { 'snapshot.secretEnc': null, 'snapshot.passphraseEnc': null } },
            { session },
          );
        }

        await User.updateOne({ _id: reset.userId }, { $set: set, $inc: inc }, { session });
        await RefreshToken.updateMany(
          { userId: reset.userId, revokedAt: null },
          { revokedAt: now },
          { session },
        );
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
