import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { DEFAULT_KDF_PARAMS, type AuthResponse, type SignupRequest } from '@serverdeck/shared';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { AppContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import type { Mailer } from '../src/lib/mailer';
import { createTokenService } from '../src/services/tokens';

export interface TestApp {
  app: Express;
  ctx: AppContext;
  /** Reset codes the API "emailed", newest last. */
  sentCodes: { to: string; code: string }[];
}

export function createTestApp(env: Partial<Record<keyof Config, string>> = {}): TestApp {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'unused-in-tests',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-chars',
    SERVER_SECRET: 'test-server-secret-at-least-32-characters',
    AUTH_RATE_LIMIT: '1000',
    ...env,
  });
  const sentCodes: TestApp['sentCodes'] = [];
  const mailer: Mailer = {
    async sendResetCode(to, code) {
      sentCodes.push({ to, code });
    },
  };
  const ctx: AppContext = {
    config,
    logger: createLogger(config),
    mailer,
    tokens: createTokenService(config),
  };
  return { app: createApp(ctx), ctx, sentCodes };
}

/** Stand-ins for client-side crypto output; the API treats them as opaque. */
export const fakeKey = () => randomBytes(32).toString('base64');
export const fakeSalt = () => randomBytes(16).toString('base64');
export const fakeCipher = () =>
  `v1:${randomBytes(12).toString('base64')}:${randomBytes(48).toString('base64')}`;

let counter = 0;
export function signupBody(overrides: Partial<SignupRequest> = {}): SignupRequest {
  counter += 1;
  return {
    name: 'Test User',
    email: `user${counter}@example.com`,
    authKey: fakeKey(),
    kdfSalt: fakeSalt(),
    kdfParams: DEFAULT_KDF_PARAMS,
    vaultKeyWrapped: fakeCipher(),
    vaultKeyRecovery: fakeCipher(),
    deviceName: 'Test PC',
    ...overrides,
  };
}

export async function signUp(app: Express, overrides: Partial<SignupRequest> = {}) {
  const body = signupBody(overrides);
  const res = await request(app).post('/auth/signup').send(body).expect(201);
  return { body, auth: res.body as AuthResponse };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
