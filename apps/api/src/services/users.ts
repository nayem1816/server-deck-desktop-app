import mongoose from 'mongoose';
import type {
  AuthResponse,
  ChangePasswordRequest,
  UpdateMeRequest,
  User as PublicUser,
} from '@serverdeck/shared';
import type { AppContext } from '../context';
import { hashAuthKey, verifyAuthKey } from '../lib/crypto';
import { AppError, invalidCredentials, notFound } from '../lib/errors';
import {
  PasswordReset,
  ProcessedMutation,
  RefreshToken,
  Server,
  ServerHistory,
  User,
  type UserDoc,
} from '../models';
import { toPublicUser, toVaultInfo } from './mappers';

export function createUserService(ctx: AppContext) {
  async function load(userId: string): Promise<UserDoc> {
    const user = await User.findById(userId).lean();
    if (!user) throw notFound('Account');
    return user;
  }

  async function requireAuthKey(user: UserDoc, authKey: string): Promise<void> {
    if (!(await verifyAuthKey(user.authHash, authKey))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is wrong');
    }
  }

  return {
    async getMe(userId: string): Promise<PublicUser> {
      return toPublicUser(await load(userId));
    },

    async updateMe(userId: string, input: UpdateMeRequest): Promise<PublicUser> {
      const user = await load(userId);
      const set: Partial<Pick<UserDoc, 'name' | 'email'>> = {};
      if (input.name !== undefined) set.name = input.name;

      if (input.email !== undefined && input.email !== user.email) {
        await requireAuthKey(user, input.currentAuthKey ?? '');
        if (await User.exists({ email: input.email })) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        set.email = input.email;
      }

      const updated = await User.findByIdAndUpdate(userId, { $set: set }, { new: true }).lean();
      if (!updated) throw notFound('Account');
      return toPublicUser(updated);
    },

    /** Re-wraps the vault key under the new password; other devices are logged out (D-009). */
    async changePassword(userId: string, input: ChangePasswordRequest): Promise<AuthResponse> {
      const user = await load(userId);
      await requireAuthKey(user, input.currentAuthKey);
      const authHash = await hashAuthKey(input.newAuthKey);

      await mongoose.connection.transaction(async (session) => {
        await User.updateOne(
          { _id: userId },
          {
            $set: {
              authHash,
              kdfSalt: input.newKdfSalt,
              kdfParams: input.newKdfParams,
              vaultKeyWrapped: input.newVaultKeyWrapped,
            },
            $inc: { tokenVersion: 1 },
          },
          { session },
        );
        await ctx.tokens.revokeAllRefreshTokens(userId, session);
      });

      const updated = await load(userId);
      const issued = await ctx.tokens.issueTokens(updated, input.deviceName);
      return { ...issued, user: toPublicUser(updated), vault: toVaultInfo(updated) };
    },

    async deleteMe(userId: string, authKey: string): Promise<void> {
      const user = await User.findById(userId).lean();
      if (!user) throw invalidCredentials();
      await requireAuthKey(user, authKey);

      await mongoose.connection.transaction(async (session) => {
        await Server.deleteMany({ userId }, { session });
        await ServerHistory.deleteMany({ userId }, { session });
        await RefreshToken.deleteMany({ userId }, { session });
        await PasswordReset.deleteMany({ userId }, { session });
        await ProcessedMutation.deleteMany({ _id: { $regex: `^${userId}:` } }, { session });
        await User.deleteOne({ _id: userId }, { session });
      });
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
