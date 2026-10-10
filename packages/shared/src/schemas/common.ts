import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });

/** 32 random bytes, base64 (authKey). */
export const keyB64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'Expected a 32-byte base64 key');
/** 16-byte base64 salt. */
export const saltB64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{22}==$/, 'Expected a 16-byte base64 salt');
/** Output of encryptBytes(): "v1:<iv>:<ciphertext>". Opaque to the API. */
export const cipherTextSchema = z
  .string()
  .max(32_768)
  .regex(/^v1:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]+$/, 'Expected an encrypted payload');

export const kdfParamsSchema = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(19_456).max(1_048_576),
  iterations: z.number().int().min(1).max(10),
  parallelism: z.number().int().min(1).max(4),
});

export const deviceNameSchema = z.string().trim().min(1).max(100);

export const errorCodes = [
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'TOKEN_REUSED',
  'INVALID_CREDENTIALS',
  'EMAIL_TAKEN',
  'INVALID_CODE',
  'NOT_FOUND',
  'ID_CONFLICT',
  'RESYNC_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
