import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import type { AuthType, KdfParams } from '@serverdeck/shared';

const uuidId = { type: String, default: () => randomUUID() };
const nullableString = { type: String, default: null };
const nullableDate = { type: Date, default: null };

// ---------- User ----------

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  authHash: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  vaultKeyWrapped: string;
  vaultKeyRecovery: string;
  /** Bumped when the vault key itself changes (reset without recovery key). */
  vaultKeyVersion: number;
  /** Bumped to invalidate every access token (logout-all, password change). */
  tokenVersion: number;
  /** Per-user sync cursor counter (DECISIONS.md D-011). */
  syncSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

const kdfParamsSchema = new Schema<KdfParams>(
  {
    algorithm: { type: String, required: true },
    memoryKiB: { type: Number, required: true },
    iterations: { type: Number, required: true },
    parallelism: { type: Number, required: true },
  },
  { _id: false },
);

export const User = model<UserDoc>(
  'User',
  new Schema<UserDoc>(
    {
      _id: uuidId,
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      authHash: { type: String, required: true },
      kdfSalt: { type: String, required: true },
      kdfParams: { type: kdfParamsSchema, required: true },
      vaultKeyWrapped: { type: String, required: true },
      vaultKeyRecovery: { type: String, required: true },
      vaultKeyVersion: { type: Number, default: 1 },
      tokenVersion: { type: Number, default: 0 },
      syncSeq: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);

// ---------- Server ----------

export interface ServerDoc {
  /** UUID made on the client. */
  _id: string;
  userId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  secretEnc: string | null;
  passphraseEnc: string | null;
  hostKeyFingerprint: string | null;
  tags: string[];
  notes: string | null;
  lastConnectedAt: Date | null;
  clientUpdatedAt: Date;
  deletedAt: Date | null;
  /** Set when a trashed server is purged; content is cleared but the tombstone stays (D-015). */
  purgedAt: Date | null;
  version: number;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
}

const serverSchema = new Schema<ServerDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, default: '' },
    host: { type: String, default: '' },
    port: { type: Number, default: 22 },
    username: { type: String, default: '' },
    authType: { type: String, enum: ['password', 'key'], default: 'password' },
    secretEnc: nullableString,
    passphraseEnc: nullableString,
    hostKeyFingerprint: nullableString,
    tags: { type: [String], default: [] },
    notes: nullableString,
    lastConnectedAt: nullableDate,
    clientUpdatedAt: { type: Date, required: true },
    deletedAt: nullableDate,
    purgedAt: nullableDate,
    version: { type: Number, default: 1 },
    seq: { type: Number, required: true },
  },
  { timestamps: true },
);
serverSchema.index({ userId: 1, seq: 1 });
serverSchema.index({ deletedAt: 1, purgedAt: 1 });
export const Server = model<ServerDoc>('Server', serverSchema);

// ---------- ServerHistory ----------

export interface ServerHistoryDoc {
  _id: string;
  userId: string;
  serverId: string;
  snapshot: Record<string, unknown>;
  reason: 'conflict' | 'restore';
  createdAt: Date;
}

const serverHistorySchema = new Schema<ServerHistoryDoc>(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    serverId: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
serverHistorySchema.index({ userId: 1, createdAt: -1 });
// History is kept 30 days, like the trash.
serverHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export const ServerHistory = model<ServerHistoryDoc>('ServerHistory', serverHistorySchema);

// ---------- RefreshToken ----------

export interface RefreshTokenDoc {
  _id: string;
  userId: string;
  /** All tokens rotated from one login share a family; reuse revokes the family (D-007). */
  familyId: string;
  tokenHash: string;
  deviceName: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    _id: uuidId,
    userId: { type: String, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    deviceName: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: nullableDate,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshToken = model<RefreshTokenDoc>('RefreshToken', refreshTokenSchema);

// ---------- PasswordReset ----------

export interface PasswordResetDoc {
  _id: string;
  userId: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  resetTokenHash: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

const passwordResetSchema = new Schema<PasswordResetDoc>(
  {
    _id: uuidId,
    userId: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    verifiedAt: nullableDate,
    resetTokenHash: { type: String, default: null, index: true },
    usedAt: nullableDate,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const PasswordReset = model<PasswordResetDoc>('PasswordReset', passwordResetSchema);

// ---------- ProcessedMutation (push idempotency, D-013) ----------

export interface ProcessedMutationDoc {
  /** `${userId}:${mutationId}` */
  _id: string;
  result: Record<string, unknown>;
  createdAt: Date;
}

const processedMutationSchema = new Schema<ProcessedMutationDoc>(
  {
    _id: { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
processedMutationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export const ProcessedMutation = model<ProcessedMutationDoc>(
  'ProcessedMutation',
  processedMutationSchema,
);

export const allModels = [User, Server, ServerHistory, RefreshToken, PasswordReset, ProcessedMutation];

