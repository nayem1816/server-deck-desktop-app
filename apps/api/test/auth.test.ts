import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { authResponseSchema } from '@serverdeck/shared';
import { Server, User } from '../src/models';
import { bearer, createTestApp, fakeCipher, fakeKey, fakeSalt, signUp, signupBody } from './helpers';

const { app, sentCodes } = createTestApp();

describe('POST /auth/prelogin', () => {
  it('returns the real salt for a known email', async () => {
    const { body } = await signUp(app);
    const res = await request(app).post('/auth/prelogin').send({ email: body.email }).expect(200);
    expect(res.body).toEqual({ kdfSalt: body.kdfSalt, kdfParams: body.kdfParams });
  });

  it('returns a stable fake salt for an unknown email', async () => {
    const a = await request(app).post('/auth/prelogin').send({ email: 'nobody@example.com' });
    const b = await request(app).post('/auth/prelogin').send({ email: 'NOBODY@example.com' });
    const c = await request(app).post('/auth/prelogin').send({ email: 'other@example.com' });
    expect(a.status).toBe(200);
    expect(a.body.kdfSalt).toBe(b.body.kdfSalt);
    expect(a.body.kdfSalt).not.toBe(c.body.kdfSalt);
  });
});

describe('POST /auth/signup', () => {
  it('creates an account and returns tokens and the vault', async () => {
    const body = signupBody({ email: 'New@Example.com' });
    const res = await request(app).post('/auth/signup').send(body).expect(201);
    const parsed = authResponseSchema.parse(res.body);
    expect(parsed.user.email).toBe('new@example.com');
    expect(parsed.vault.vaultKeyWrapped).toBe(body.vaultKeyWrapped);
    expect(parsed.vault.vaultKeyVersion).toBe(1);

    const stored = await User.findOne({ email: 'new@example.com' }).lean();
    expect(stored?.authHash).toMatch(/^\$argon2id\$/);
    expect(stored?.authHash).not.toContain(body.authKey);
  });

  it('rejects a duplicate email', async () => {
    const { body } = await signUp(app);
    const res = await request(app)
      .post('/auth/signup')
      .send(signupBody({ email: body.email }))
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('returns field errors for invalid input', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ ...signupBody(), email: 'not-an-email', authKey: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fieldErrors).toHaveProperty('email');
    expect(res.body.error.details.fieldErrors).toHaveProperty('authKey');
  });

  it('rejects malformed JSON with the standard error shape', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_JSON', message: expect.any(String) },
    });
  });
});

describe('POST /auth/login', () => {
  it('logs in with the right auth key, ignoring email case', async () => {
    const { body } = await signUp(app);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: body.email.toUpperCase(), authKey: body.authKey, deviceName: 'Laptop' })
      .expect(200);
    expect(authResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('gives the same error for a wrong key and an unknown email', async () => {
    const { body } = await signUp(app);
    const wrong = await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: fakeKey(), deviceName: 'X' })
      .expect(401);
    const unknown = await request(app)
      .post('/auth/login')
      .send({ email: 'ghost@example.com', authKey: fakeKey(), deviceName: 'X' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('access tokens', () => {
  it('protects /me', async () => {
    const { auth } = await signUp(app);
    await request(app).get('/me').set(bearer(auth.accessToken)).expect(200);
    const none = await request(app).get('/me').expect(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');
    await request(app).get('/me').set(bearer('garbage')).expect(401);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token', async () => {
    const { auth } = await signUp(app);
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(200);
    expect(res.body.refreshToken).not.toBe(auth.refreshToken);
    await request(app).get('/me').set(bearer(res.body.accessToken)).expect(200);
  });

  it('revokes the whole family when an old token is reused', async () => {
    const { auth } = await signUp(app);
    const first = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(200);

    const reuse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSED');

    // The legitimately rotated token is now dead too.
    await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'nope' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('logout', () => {
  it('revokes this device only', async () => {
    const { body, auth } = await signUp(app);
    const other = await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: body.authKey, deviceName: 'Other PC' });

    await request(app).post('/auth/logout').send({ refreshToken: auth.refreshToken }).expect(204);
    await request(app).post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: other.body.refreshToken })
      .expect(200);
  });

  it('logout-all kills every refresh token and access token immediately', async () => {
    const { body, auth } = await signUp(app);
    const other = await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: body.authKey, deviceName: 'Other PC' });

    await request(app).post('/auth/logout-all').set(bearer(auth.accessToken)).expect(204);

    await request(app).get('/me').set(bearer(auth.accessToken)).expect(401);
    await request(app).get('/me').set(bearer(other.body.accessToken)).expect(401);
    await request(app).post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: other.body.refreshToken })
      .expect(401);
  });
});

describe('password reset', () => {
  async function requestCode(email: string): Promise<string> {
    await request(app).post('/auth/forgot-password').send({ email }).expect(204);
    // The mailer is called without await; give it a tick.
    await new Promise((r) => setImmediate(r));
    const sent = sentCodes.filter((c) => c.to === email).at(-1);
    if (!sent) throw new Error('No code sent');
    return sent.code;
  }

  function newKeys() {
    return {
      newAuthKey: fakeKey(),
      newKdfSalt: fakeSalt(),
      newKdfParams: { algorithm: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 },
      newVaultKeyWrapped: fakeCipher(),
    };
  }

  it('does not reveal unknown emails', async () => {
    const before = sentCodes.length;
    await request(app).post('/auth/forgot-password').send({ email: 'ghost@example.com' }).expect(204);
    expect(sentCodes.length).toBe(before);
  });

  it('resets with the recovery key and keeps the vault', async () => {
    const { body, auth } = await signUp(app);
    const code = await requestCode(body.email);

    const verify = await request(app)
      .post('/auth/reset-password/verify')
      .send({ email: body.email, code })
      .expect(200);
    expect(verify.body.vaultKeyRecovery).toBe(body.vaultKeyRecovery);

    const keys = newKeys();
    await request(app)
      .post('/auth/reset-password')
      .send({ resetToken: verify.body.resetToken, ...keys, secretsReset: false })
      .expect(204);

    // Old credentials and sessions are gone; new ones work.
    await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: body.authKey, deviceName: 'X' })
      .expect(401);
    await request(app).post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    await request(app).get('/me').set(bearer(auth.accessToken)).expect(401);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: keys.newAuthKey, deviceName: 'X' })
      .expect(200);
    expect(login.body.vault.vaultKeyWrapped).toBe(keys.newVaultKeyWrapped);
    expect(login.body.vault.vaultKeyVersion).toBe(1);

    // The reset token is single-use.
    await request(app)
      .post('/auth/reset-password')
      .send({ resetToken: verify.body.resetToken, ...newKeys(), secretsReset: false })
      .expect(400);
  });

  it('wipes saved secrets when reset without a recovery key', async () => {
    const { body, auth } = await signUp(app);
    await User.updateOne({ _id: auth.user.id }, { syncSeq: 1 });
    await Server.create({
      _id: '6f1c9a52-6a43-4d4e-9d0c-0f6d6b1a2b3c',
      userId: auth.user.id,
      name: 'web-1',
      host: '10.0.0.1',
      username: 'root',
      authType: 'password',
      secretEnc: fakeCipher(),
      clientUpdatedAt: new Date(),
      seq: 1,
    });

    const code = await requestCode(body.email);
    const verify = await request(app)
      .post('/auth/reset-password/verify')
      .send({ email: body.email, code });
    const newRecovery = fakeCipher();
    await request(app)
      .post('/auth/reset-password')
      .send({
        resetToken: verify.body.resetToken,
        ...newKeys(),
        secretsReset: true,
        newVaultKeyRecovery: newRecovery,
      })
      .expect(204);

    const server = await Server.findById('6f1c9a52-6a43-4d4e-9d0c-0f6d6b1a2b3c').lean();
    expect(server?.secretEnc).toBeNull();
    expect(server?.name).toBe('web-1');
    expect(server?.version).toBe(2);
    const user = await User.findById(auth.user.id).lean();
    expect(server?.seq).toBe(2);
    expect(user?.syncSeq).toBe(2);
    expect(user?.vaultKeyVersion).toBe(2);
    expect(user?.vaultKeyRecovery).toBe(newRecovery);
  });

  it('requires newVaultKeyRecovery when secrets are reset', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ resetToken: 'x', ...newKeys(), secretsReset: true })
      .expect(400);
    expect(res.body.error.details.fieldErrors).toHaveProperty('newVaultKeyRecovery');
  });

  it('locks the code after 5 wrong attempts', async () => {
    const { body } = await signUp(app);
    const code = await requestCode(body.email);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/auth/reset-password/verify')
        .send({ email: body.email, code: wrong })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CODE');
    }
    await request(app)
      .post('/auth/reset-password/verify')
      .send({ email: body.email, code })
      .expect(400);
  });

  it('invalidates the previous code when a new one is requested', async () => {
    const { body } = await signUp(app);
    const first = await requestCode(body.email);
    const second = await requestCode(body.email);
    if (first !== second) {
      await request(app)
        .post('/auth/reset-password/verify')
        .send({ email: body.email, code: first })
        .expect(400);
    }
    await request(app)
      .post('/auth/reset-password/verify')
      .send({ email: body.email, code: second })
      .expect(200);
  });
});

describe('rate limiting', () => {
  it('blocks login after the limit per IP + email', async () => {
    const limited = createTestApp({ AUTH_RATE_LIMIT: '3' });
    const { body } = await signUp(limited.app);
    const attempt = (email: string) =>
      request(limited.app)
        .post('/auth/login')
        .send({ email, authKey: fakeKey(), deviceName: 'X' });

    for (let i = 0; i < 3; i++) expect((await attempt(body.email)).status).toBe(401);
    const blocked = await attempt(body.email);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // A different email from the same IP has its own budget.
    expect((await attempt('someone-else@example.com')).status).toBe(401);
  });
});

describe('misc', () => {
  it('GET /health reports the database', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: true });
  });

  it('unknown routes use the error shape', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
