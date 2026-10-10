import type { ClientSession } from 'mongoose';
import type { User as PublicUser, VaultInfo } from '@serverdeck/shared';
import { User, type UserDoc } from '../models';

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toVaultInfo(user: UserDoc): VaultInfo {
  return {
    vaultKeyWrapped: user.vaultKeyWrapped,
    kdfSalt: user.kdfSalt,
    kdfParams: {
      algorithm: user.kdfParams.algorithm,
      memoryKiB: user.kdfParams.memoryKiB,
      iterations: user.kdfParams.iterations,
      parallelism: user.kdfParams.parallelism,
    },
    vaultKeyVersion: user.vaultKeyVersion,
  };
}

/**
 * Next value of the user's sync cursor (D-011). Must run inside the write's transaction:
 * updating the user document also serializes concurrent writers for that user.
 */
export async function nextSyncSeq(userId: string, session: ClientSession): Promise<number> {
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { syncSeq: 1 } },
    { new: true, session, projection: { syncSeq: 1 } },
  ).lean();
  if (!user) throw new Error(`User ${userId} not found`);
  return user.syncSeq;
}
