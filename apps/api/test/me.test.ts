import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { RefreshToken, Server, User } from '../src/models';
import { bearer, createTestApp, fakeCipher, fakeKey, fakeSalt, signUp } from './helpers';

const { app } = createTestApp();

describe('GET /me', () => {
  it('returns the profile without secrets', async () => {
    const { body, auth } = await signUp(app, { name: 'Nayem' });
    const res = await request(app).get('/me').set(bearer(auth.accessToken)).expect(200);
    expect(res.body).toEqual({
      id: auth.user.id,
      name: 'Nayem',
      email: body.email,
      createdAt: expect.any(String),
    });
  });
});

describe('PATCH /me', () => {
  it('changes the name', async () => {
    const { auth } = await signUp(app);
    const res = await request(app)
      .patch('/me')
      .set(bearer(auth.accessToken))
      .send({ name: 'New Name' })
      .expect(200);
    expect(res.body.name).toBe('New Name');
  });

  it('needs the current password to change email', async () => {
    const { body, auth } = await signUp(app);
    await request(app)
      .patch('/me')
      .set(bearer(auth.accessToken))
      .send({ email: 'changed@example.com' })
      .expect(400);
    const wrong = await request(app)
      .patch('/me')
      .set(bearer(auth.accessToken))
      .send({ email: 'changed@example.com', currentAuthKey: fakeKey() })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await request(app)
      .patch('/me')
      .set(bearer(auth.accessToken))
      .send({ email: 'Changed@example.com', currentAuthKey: body.authKey })
      .expect(200);
    expect(ok.body.email).toBe('changed@example.com');
  });

  it('rejects an email that is taken', async () => {
    const other = await signUp(app);
    const { body, auth } = await signUp(app);
    const res = await request(app)
      .patch('/me')
      .set(bearer(auth.accessToken))
      .send({ email: other.body.email, currentAuthKey: body.authKey })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('POST /me/password', () => {
  it('re-wraps the vault, logs out other sessions, and returns fresh tokens', async () => {
    const { body, auth } = await signUp(app);
    const newKeys = {
      currentAuthKey: body.authKey,
      newAuthKey: fakeKey(),
      newKdfSalt: fakeSalt(),
      newKdfParams: body.kdfParams,
      newVaultKeyWrapped: fakeCipher(),
      deviceName: 'Test PC',
    };
    const res = await request(app)
      .post('/me/password')
      .set(bearer(auth.accessToken))
      .send(newKeys)
      .expect(200);

    expect(res.body.vault.vaultKeyWrapped).toBe(newKeys.newVaultKeyWrapped);
    expect(res.body.vault.kdfSalt).toBe(newKeys.newKdfSalt);
    await request(app).get('/me').set(bearer(auth.accessToken)).expect(401);
    await request(app).get('/me').set(bearer(res.body.accessToken)).expect(200);
    await request(app).post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    await request(app)
      .post('/auth/login')
      .send({ email: body.email, authKey: newKeys.newAuthKey, deviceName: 'X' })
      .expect(200);
  });

  it('rejects a wrong current password', async () => {
    const { body, auth } = await signUp(app);
    await request(app)
      .post('/me/password')
      .set(bearer(auth.accessToken))
      .send({
        currentAuthKey: fakeKey(),
        newAuthKey: fakeKey(),
        newKdfSalt: fakeSalt(),
        newKdfParams: body.kdfParams,
        newVaultKeyWrapped: fakeCipher(),
        deviceName: 'X',
      })
      .expect(401);
  });
});

describe('DELETE /me', () => {
  it('needs the password, then deletes all data', async () => {
    const { body, auth } = await signUp(app);
    const other = await signUp(app);
    for (const userId of [auth.user.id, other.auth.user.id]) {
      await Server.create({
        _id: crypto.randomUUID(),
        userId,
        name: 's',
        host: 'h',
        username: 'u',
        clientUpdatedAt: new Date(),
        seq: 1,
      });
    }

    await request(app)
      .delete('/me')
      .set(bearer(auth.accessToken))
      .send({ authKey: fakeKey() })
      .expect(401);
    await request(app)
      .delete('/me')
      .set(bearer(auth.accessToken))
      .send({ authKey: body.authKey })
      .expect(204);

    expect(await User.exists({ _id: auth.user.id })).toBeNull();
    expect(await Server.countDocuments({ userId: auth.user.id })).toBe(0);
    expect(await RefreshToken.countDocuments({ userId: auth.user.id })).toBe(0);
    // Other users are untouched.
    expect(await Server.countDocuments({ userId: other.auth.user.id })).toBe(1);
    await request(app).get('/me').set(bearer(auth.accessToken)).expect(401);
  });
});
