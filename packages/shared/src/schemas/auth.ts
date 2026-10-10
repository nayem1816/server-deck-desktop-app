import { z } from 'zod';
import {
  cipherTextSchema,
  deviceNameSchema,
  emailSchema,
  kdfParamsSchema,
  keyB64Schema,
  saltB64Schema,
} from './common';
import { userSchema } from './user';

export const preloginRequestSchema = z.object({ email: emailSchema });
export const preloginResponseSchema = z.object({
  kdfSalt: saltB64Schema,
  kdfParams: kdfParamsSchema,
});

export const signupRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  authKey: keyB64Schema,
  kdfSalt: saltB64Schema,
  kdfParams: kdfParamsSchema,
  vaultKeyWrapped: cipherTextSchema,
  vaultKeyRecovery: cipherTextSchema,
  deviceName: deviceNameSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  authKey: keyB64Schema,
  deviceName: deviceNameSchema,
});

export const vaultInfoSchema = z.object({
  vaultKeyWrapped: cipherTextSchema,
  kdfSalt: saltB64Schema,
  kdfParams: kdfParamsSchema,
  vaultKeyVersion: z.number().int().min(1),
});

export const authResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: userSchema,
  vault: vaultInfoSchema,
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1).max(200) });
export const tokensResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const logoutRequestSchema = refreshRequestSchema;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });

export const verifyResetCodeRequestSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export const verifyResetCodeResponseSchema = z.object({
  resetToken: z.string(),
  /** Vault key encrypted with the recovery key; the client unwraps it if the user has the key. */
  vaultKeyRecovery: cipherTextSchema,
});

export const resetPasswordRequestSchema = z
  .object({
    resetToken: z.string().min(1).max(200),
    newAuthKey: keyB64Schema,
    newKdfSalt: saltB64Schema,
    newKdfParams: kdfParamsSchema,
    newVaultKeyWrapped: cipherTextSchema,
    /** true = no recovery key: a new vault key was made and all saved secrets are wiped. */
    secretsReset: z.boolean(),
    newVaultKeyRecovery: cipherTextSchema.optional(),
  })
  .refine((v) => !v.secretsReset || v.newVaultKeyRecovery, {
    message: 'newVaultKeyRecovery is required when secretsReset is true',
    path: ['newVaultKeyRecovery'],
  });

export type PreloginRequest = z.infer<typeof preloginRequestSchema>;
export type PreloginResponse = z.infer<typeof preloginResponseSchema>;
export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type VaultInfo = z.infer<typeof vaultInfoSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type TokensResponse = z.infer<typeof tokensResponseSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type VerifyResetCodeRequest = z.infer<typeof verifyResetCodeRequestSchema>;
export type VerifyResetCodeResponse = z.infer<typeof verifyResetCodeResponseSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
