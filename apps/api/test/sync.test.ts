import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PullResponse, PushChange, PushResult, ServerRecord } from '@serverdeck/shared';
import { Server, ServerHistory } from '../src/models';
import { createSyncService } from '../src/services/sync';
import { bearer, createTestApp, fakeCipher, signUp } from './helpers';

const { app } = createTestApp();

function record(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: randomUUID(),
    name: 'web-1',
    host: '10.0.0.5',
    port: 22,
    username: 'root',
    authType: 'password',
    secretEnc: fakeCipher(),
    passphraseEnc: null,
    hostKeyFingerprint: null,
    tags: ['prod'],
    notes: null,
    lastConnectedAt: null,
    clientUpdatedAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

async function user() {
  const { auth } = await signUp(app);
  const token = auth.accessToken;
  const push = async (...changes: Omit<PushChange, 'mutationId'>[]) => {
    const res = await request(app)
      .post('/sync/push')
      .set(bearer(token))
      .send({ changes: changes.map((c) => ({ mutationId: randomUUID(), ...c })) })
      .expect(200);
    return res.body.results as PushResult[];
  };
  const pull = async (since = 0, limit?: number) => {
    const res = await request(app)
      .get('/sync/pull')
      .query(limit ? { since, limit } : { since })
      .set(bearer(token))
      .expect(200);
    return res.body as PullResponse;
  };
  return { token, userId: auth.user.id, push, pull };
}

describe('push + pull', () => {
  it('creates a server and returns it on pull', async () => {
    const u = await user();
    const server = record();
    const [result] = await u.push({ baseVersion: 0, server });
    expect(result).toMatchObject({ status: 'applied', conflict: false, server: { id: server.id, version: 1 } });

    const page = await u.pull(0);
    expect(page.servers.map((s) => s.id)).toEqual([server.id]);
    expect(page.servers[0]!.secretEnc).toBe(server.secretEnc);
    expect(page.cursor).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);

    const empty = await u.pull(page.cursor);
    expect(empty.servers).toEqual([]);
    expect(empty.cursor).toBe(page.cursor);
  });

  it('applies an edit based on the current version', async () => {
    const u = await user();
    const server = record();
    await u.push({ baseVersion: 0, server });
    const [result] = await u.push({ baseVersion: 1, server: { ...server, name: 'renamed', clientUpdatedAt: later(10) } });
    expect(result).toMatchObject({ status: 'applied', conflict: false, server: { name: 'renamed', version: 2 } });
  });

  it('is idempotent per mutationId', async () => {
    const u = await user();
    const change = { mutationId: randomUUID(), baseVersion: 0, server: record() };
    const send = () => request(app).post('/sync/push').set(bearer(u.token)).send({ changes: [change] });
    const first = await send();
    const retry = await send();
    expect(retry.body).toEqual(first.body);
    expect((await Server.findById(change.server.id).lean())?.version).toBe(1);
  });

  it('keeps users apart', async () => {
    const a = await user();
    const b = await user();
    await a.push({ baseVersion: 0, server: record() });
    expect((await b.pull(0)).servers).toEqual([]);
  });

  it('rejects a server id that belongs to another account', async () => {
    const a = await user();
    const b = await user();
    const server = record();
    await a.push({ baseVersion: 0, server });
    const [result] = await b.push({ baseVersion: 0, server: { ...server, name: 'hijack' } });
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'ID_CONFLICT' } });
    expect((await Server.findById(server.id).lean())?.name).toBe('web-1');
  });

  it('validates records', async () => {
    const u = await user();
    const res = await request(app)
      .post('/sync/push')
      .set(bearer(u.token))
      .send({ changes: [{ mutationId: randomUUID(), baseVersion: 0, server: { ...record(), secretEnc: 'plain-password' } }] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires auth', async () => {
    await request(app).get('/sync/pull').expect(401);
  });
});

describe('conflicts', () => {
  async function setup() {
    const u = await user();
    const server = record();
    await u.push({ baseVersion: 0, server });
    // Device B edits first and bumps the version to 2.
    await u.push({ baseVersion: 1, server: { ...server, name: 'from-B', clientUpdatedAt: later(1_000) } });
    return { u, server };
  }

  it('newer edit wins and the older copy goes to history', async () => {
    const { u, server } = await setup();
    const [result] = await u.push({ baseVersion: 1, server: { ...server, name: 'from-A', clientUpdatedAt: later(5_000) } });
    expect(result).toMatchObject({ status: 'applied', conflict: true, server: { name: 'from-A', version: 3 } });
    const history = await ServerHistory.find({ serverId: server.id }).lean();
    expect(history.map((h) => h.snapshot.name)).toEqual(['from-B']);
  });

  it('older edit loses, is kept in history, and the winner is returned', async () => {
    const { u, server } = await setup();
    const [result] = await u.push({ baseVersion: 1, server: { ...server, name: 'from-A', clientUpdatedAt: later(500) } });
    expect(result).toMatchObject({ status: 'conflict_lost', conflict: true, server: { name: 'from-B' } });
    const history = await ServerHistory.find({ serverId: server.id }).lean();
    expect(history.map((h) => h.snapshot.name)).toEqual(['from-A']);
  });

  it('a newer delete beats an older edit', async () => {
    const { u, server } = await setup();
    const deletedAt = later(5_000);
    const [result] = await u.push({ baseVersion: 1, server: { ...server, deletedAt, clientUpdatedAt: deletedAt } });
    expect(result).toMatchObject({ status: 'applied', server: { deletedAt } });
  });

  it('connection metadata alone never conflicts and merges as newest', async () => {
    const { u, server } = await setup();
    const connectedAt = later(2_000);
    // Same content as the original, stale base version, only lastConnectedAt + fingerprint changed.
    const [result] = await u.push({
      baseVersion: 1,
      server: { ...server, name: 'from-B', clientUpdatedAt: server.clientUpdatedAt, lastConnectedAt: connectedAt, hostKeyFingerprint: 'SHA256:x' },
    });
    expect(result).toMatchObject({ status: 'applied', conflict: false });
    if (result?.status !== 'applied') throw new Error('unreachable');
    expect(result.server.lastConnectedAt).toBe(connectedAt);
    expect(result.server.hostKeyFingerprint).toBe('SHA256:x');
    expect(await ServerHistory.countDocuments({ serverId: server.id })).toBe(0);
  });
});

describe('cursor', () => {
  it('pages with hasMore', async () => {
    const u = await user();
    await u.push(...Array.from({ length: 5 }, () => ({ baseVersion: 0, server: record() })));
    const first = await u.pull(0, 3);
    expect(first.servers).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await u.pull(first.cursor, 3);
    expect(second.servers).toHaveLength(2);
    expect(second.hasMore).toBe(false);
  });

  it('never skips changes from concurrent pushes', async () => {
    const u = await user();
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await Promise.all(ids.map((id) => u.push({ baseVersion: 0, server: record({ id }) })));

    const seqs = (await Server.find({ userId: u.userId }).lean()).map((s) => s.seq);
    expect(new Set(seqs).size).toBe(20);

    const pulled: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await u.pull(cursor, 7);
      pulled.push(...page.servers.map((s) => s.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(pulled.sort()).toEqual([...ids].sort());
  });
});

describe('trash, purge and history', () => {
  it('lists and restores deleted servers', async () => {
    const u = await user();
    const server = record();
    await u.push({ baseVersion: 0, server });
    const deletedAt = later(10);
    await u.push({ baseVersion: 1, server: { ...server, deletedAt, clientUpdatedAt: deletedAt } });

    const trash = await request(app).get('/servers/trash').set(bearer(u.token)).expect(200);
    expect(trash.body.servers.map((s: { id: string }) => s.id)).toEqual([server.id]);

    const restored = await request(app).post(`/servers/${server.id}/restore`).set(bearer(u.token)).expect(200);
    expect(restored.body.deletedAt).toBeNull();
    expect(restored.body.version).toBe(3);
  });

  it('purges after 30 days but keeps a tombstone for pull', async () => {
    const u = await user();
    const server = record();
    await u.push({ baseVersion: 0, server });
    const { cursor } = await u.pull(0);
    const deletedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    await u.push({ baseVersion: 1, server: { ...server, deletedAt, clientUpdatedAt: later(10) } });

    expect(await createSyncService().purgeTrash()).toBe(1);
    const doc = await Server.findById(server.id).lean();
    expect(doc).toMatchObject({ name: '', secretEnc: null });
    expect(doc?.purgedAt).not.toBeNull();

    const page = await u.pull(cursor);
    expect(page.purgedIds).toEqual([server.id]);
    expect(page.servers).toEqual([]);
    const trash = await request(app).get('/servers/trash').set(bearer(u.token)).expect(200);
    expect(trash.body.servers).toEqual([]);
  });

  it('restores a version from history', async () => {
    const u = await user();
    const server = record();
    await u.push({ baseVersion: 0, server });
    await u.push({ baseVersion: 1, server: { ...server, name: 'from-B', clientUpdatedAt: later(1_000) } });
    await u.push({ baseVersion: 1, server: { ...server, name: 'from-A', clientUpdatedAt: later(5_000) } });

    const list = await request(app).get('/servers/history').set(bearer(u.token)).expect(200);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]).toMatchObject({ serverId: server.id, name: 'from-B', reason: 'conflict' });

    const restored = await request(app)
      .post(`/servers/history/${list.body.entries[0].id}/restore`)
      .set(bearer(u.token))
      .expect(200);
    expect(restored.body.name).toBe('from-B');

    // The replaced copy is now in history, so the restore can be undone.
    const after = await request(app).get('/servers/history').set(bearer(u.token)).expect(200);
    expect(after.body.entries.map((e: { name: string }) => e.name)).toEqual(['from-A']);
  });

  it("can't restore another user's history", async () => {
    const a = await user();
    const b = await user();
    const server = record();
    await a.push({ baseVersion: 0, server });
    await a.push({ baseVersion: 1, server: { ...server, name: 'x', clientUpdatedAt: later(1_000) } });
    await a.push({ baseVersion: 1, server: { ...server, name: 'y', clientUpdatedAt: later(5_000) } });
    const [entry] = await ServerHistory.find({ userId: a.userId }).lean();
    await request(app).post(`/servers/history/${entry!._id}/restore`).set(bearer(b.token)).expect(404);
  });
});
