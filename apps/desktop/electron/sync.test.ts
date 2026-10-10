import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PushChange, PushResult, SyncedServer, SyncState } from '@serverdeck/shared';
import { ApiClient } from './apiClient';
import { LocalDb } from './localdb';
import { SyncEngine } from './sync';

/** Minimal in-memory stand-in for the API's /sync endpoints. */
class FakeApi {
  servers = new Map<string, SyncedServer>();
  seq = 0;
  online = true;
  reject = new Set<string>();
  /** Changes for these ids lose a conflict against the stored copy. */
  loseConflict = new Set<string>();

  fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === '/auth/refresh') return json({ accessToken: 'a', refreshToken: 'r' });
    if (url.pathname === '/sync/push') {
      const { changes } = JSON.parse(String(init?.body)) as { changes: PushChange[] };
      const results: PushResult[] = changes.map((c) => {
        if (this.reject.has(c.server.id)) {
          return { status: 'rejected', mutationId: c.mutationId, id: c.server.id, error: { code: 'ID_CONFLICT', message: 'x' } };
        }
        if (this.loseConflict.has(c.server.id)) {
          return { status: 'conflict_lost', mutationId: c.mutationId, id: c.server.id, conflict: true, server: this.servers.get(c.server.id)! };
        }
        const prev = this.servers.get(c.server.id);
        const stored = { ...c.server, version: (prev?.version ?? 0) + 1, seq: ++this.seq, updatedAt: new Date().toISOString() };
        this.servers.set(stored.id, stored);
        return { status: 'applied', mutationId: c.mutationId, id: stored.id, conflict: false, server: stored };
      });
      return json({ results });
    }
    if (url.pathname === '/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const servers = [...this.servers.values()].filter((s) => s.seq > since).sort((a, b) => a.seq - b.seq);
      return json({ servers, purgedIds: [], cursor: servers.at(-1)?.seq ?? since, hasMore: false });
    }
    return new Response('{}', { status: 404 });
  };
}

const record = (id: string, name: string) => ({
  id,
  name,
  host: 'h',
  port: 22,
  username: 'u',
  authType: 'password' as const,
  secretEnc: null,
  passphraseEnc: null,
  hostKeyFingerprint: null,
  tags: [],
  notes: null,
  lastConnectedAt: null,
  clientUpdatedAt: new Date().toISOString(),
  deletedAt: null,
});

let dir: string;
let db: LocalDb;
let fake: FakeApi;
let engine: SyncEngine;
let states: SyncState[];
let changes: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverdeck-sync-'));
  db = new LocalDb(path.join(dir, 'db.sqlite'));
  fake = new FakeApi();
  const api = new ApiClient(
    'http://api.test',
    { getRefreshToken: () => 'r', setRefreshToken: () => undefined, onSessionEnded: () => undefined },
    fake.fetch,
  );
  states = [];
  changes = 0;
  engine = new SyncEngine({
    api,
    db: () => db,
    onState: (s) => states.push(s),
    onDataChanged: () => changes++,
    intervalMs: 3_600_000,
  });
});

afterEach(() => {
  engine.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SyncEngine', () => {
  it('pushes local changes and pulls remote ones', async () => {
    db.saveLocal(record('11111111-1111-4111-8111-111111111111', 'local'));
    const remote = { ...record('22222222-2222-4222-8222-222222222222', 'remote'), version: 1, seq: 0, updatedAt: new Date().toISOString() };
    fake.servers.set(remote.id, { ...remote, seq: ++fake.seq });

    engine.start();
    await engine.syncNow();

    expect(db.pendingCount()).toBe(0);
    expect(fake.servers.get('11111111-1111-4111-8111-111111111111')?.name).toBe('local');
    expect(db.getServer('22222222-2222-4222-8222-222222222222')?.record.name).toBe('remote');
    expect(engine.getState()).toMatchObject({ status: 'synced', pendingChanges: 0 });
    expect(changes).toBeGreaterThan(0);
  });

  it('keeps changes queued while offline and reports it', async () => {
    fake.online = false;
    db.saveLocal(record('11111111-1111-4111-8111-111111111111', 'offline edit'));
    engine.start();
    await engine.syncNow();
    expect(engine.getState()).toMatchObject({
      status: 'offline',
      pendingChanges: 1,
      message: 'Offline — changes saved, will sync',
    });

    fake.online = true;
    await engine.syncNow();
    expect(engine.getState()).toMatchObject({ status: 'synced', pendingChanges: 0 });
    expect(fake.servers.size).toBe(1);
  });

  it('takes the winning copy when a conflict is lost', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    fake.servers.set(id, { ...record(id, 'winner'), version: 4, seq: ++fake.seq, updatedAt: new Date().toISOString() });
    fake.loseConflict.add(id);
    db.saveLocal(record(id, 'loser'));

    engine.start();
    await engine.syncNow();
    expect(db.getServer(id)).toMatchObject({ record: { name: 'winner' }, version: 4, pending: false });
  });

  it('drops a change the API permanently rejects', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    fake.reject.add(id);
    db.saveLocal(record(id, 'x'));
    engine.start();
    await engine.syncNow();
    expect(db.pendingCount()).toBe(0);
    expect(engine.getState().status).toBe('synced');
  });
});
