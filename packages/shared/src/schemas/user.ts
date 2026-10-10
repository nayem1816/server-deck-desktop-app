import { z } from 'zod';
import {
  cipherTextSchema,
  deviceNameSchema,
  emailSchema,
  isoDateSchema,
  kdfParamsSchema,
  keyB64Schema,
  saltB64Schema,
} from './common';

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  createdAt: isoDateSchema,
});

export const updateMeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: emailSchema.optional(),
    /** Required when changing email. */
    currentAuthKey: keyB64Schema.optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined, { message: 'Nothing to update' })
  .refine((v) => v.email === undefined || v.currentAuthKey, {
    message: 'currentAuthKey is required to change email',
    path: ['currentAuthKey'],
  });

export const changePasswordRequestSchema = z.object({
  currentAuthKey: keyB64Schema,
  newAuthKey: keyB64Schema,
  newKdfSalt: saltB64Schema,
  newKdfParams: kdfParamsSchema,
  newVaultKeyWrapped: cipherTextSchema,
  deviceName: deviceNameSchema,
});

export const deleteMeRequestSchema = z.object({ authKey: keyB64Schema });

export type User = z.infer<typeof userSchema>;
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type DeleteMeRequest = z.infer<typeof deleteMeRequestSchema>;
