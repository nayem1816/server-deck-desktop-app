import { z } from 'zod';
import { isoDateSchema, uuidSchema } from './common';
import { serverRecordSchema, syncedServerSchema } from './server';

export const PUSH_BATCH_LIMIT = 100;

export const pushChangeSchema = z.object({
  /** Idempotency key (D-013). A new one is made for every local edit. */
  mutationId: uuidSchema,
  /** The server version this edit was based on; 0 for a server that was never synced. */
  baseVersion: z.number().int().min(0),
  server: serverRecordSchema,
});

export const pushRequestSchema = z.object({
  changes: z.array(pushChangeSchema).min(1).max(PUSH_BATCH_LIMIT),
});

export const pushResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    mutationId: uuidSchema,
    id: uuidSchema,
    /** True when another device's edit was overwritten (kept in history). */
    conflict: z.boolean(),
    server: syncedServerSchema,
  }),
  z.object({
    status: z.literal('conflict_lost'),
    mutationId: uuidSchema,
    id: uuidSchema,
    conflict: z.literal(true),
    /** The newer copy that won; this device's edit is kept in history. */
    server: syncedServerSchema,
  }),
  z.object({
    status: z.literal('rejected'),
    mutationId: uuidSchema,
    id: uuidSchema,
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export const pushResponseSchema = z.object({ results: z.array(pushResultSchema) });

export const pullQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const pullResponseSchema = z.object({
  servers: z.array(syncedServerSchema),
  /** Servers deleted more than 30 days ago; their content is gone (D-015). */
  purgedIds: z.array(uuidSchema),
  cursor: z.number().int().min(0),
  hasMore: z.boolean(),
});

export const historyEntrySchema = z.object({
  id: z.string(),
  serverId: uuidSchema,
  name: z.string(),
  host: z.string(),
  reason: z.enum(['conflict', 'restore']),
  createdAt: isoDateSchema,
});

export const historyListResponseSchema = z.object({ entries: z.array(historyEntrySchema) });
export const trashListResponseSchema = z.object({ servers: z.array(syncedServerSchema) });

export type PushChange = z.infer<typeof pushChangeSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushResult = z.infer<typeof pushResultSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type PullQuery = z.infer<typeof pullQuerySchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;
