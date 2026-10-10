import { z } from 'zod';
import { cipherTextSchema, isoDateSchema, uuidSchema } from './common';

export const authTypeSchema = z.enum(['password', 'key']);

const hostSchema = z
  .string()
  .trim()
  .min(1, 'Host is required')
  .max(253)
  .regex(/^[A-Za-z0-9._:%[\]-]+$/, 'Enter an IP address or domain name');

/** A server as stored and synced. Secrets are ciphertext; the API never sees plain values. */
export const serverRecordSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(100),
  host: hostSchema,
  port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(64),
  authType: authTypeSchema,
  secretEnc: cipherTextSchema.nullable(),
  passphraseEnc: cipherTextSchema.nullable(),
  hostKeyFingerprint: z.string().max(200).nullable(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20),
  notes: z.string().max(5_000).nullable(),
  lastConnectedAt: isoDateSchema.nullable(),
  /** Device clock at the time of the edit; used to pick a conflict winner. */
  clientUpdatedAt: isoDateSchema,
  deletedAt: isoDateSchema.nullable(),
});

/** What the API returns: the record plus server-assigned fields. */
export const syncedServerSchema = serverRecordSchema.extend({
  version: z.number().int().min(1),
  seq: z.number().int().min(1),
  updatedAt: isoDateSchema,
});

/** Plain form values in the UI, before secrets are encrypted in the main process. */
export const serverFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  host: hostSchema,
  port: z.coerce.number().int().min(1).max(65_535).default(22),
  username: z.string().trim().min(1, 'Username is required').max(64),
  authType: authTypeSchema,
  password: z.string().max(4_096).optional(),
  privateKey: z.string().max(16_384).optional(),
  passphrase: z.string().max(1_024).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  notes: z.string().max(5_000).optional(),
});

export type AuthType = z.infer<typeof authTypeSchema>;
export type ServerRecord = z.infer<typeof serverRecordSchema>;
export type SyncedServer = z.infer<typeof syncedServerSchema>;
export type ServerForm = z.infer<typeof serverFormSchema>;
