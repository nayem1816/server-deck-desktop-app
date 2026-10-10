import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVaultKey, type ServerForm, type SyncedServer } from '@serverdeck/shared';
import { DesktopError } from './errors';
import { LocalDb } from './localdb';
import { ServerRepo } from './servers';
import { Vault } from './vault';

const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;

const form = (overrides: Partial<ServerForm> = {}): ServerForm => ({
  name: 'web-1',
  host: '10.0.0.5',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'hunter2',
  tags: ['prod'],
  ...overrides,
});

let dir: string;
let db: LocalDb;
let vault: Vault;
let repo: ServerRepo;
let onChange: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverdeck-test-'));
  db = new LocalDb(path.join(dir, 'test.sqlite'));
  vault = new Vault();
  vault.set(generateVaultKey());
  onChange = vi.fn();
  repo = new ServerRepo(() => db, vault, onChange);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ServerRepo', () => {
  it('creates a server with an encrypted secret and queues it', async () => {
    const view = await repo.create(form());
    expect(view).toMatchObject({ name: 'web-1', hasSecret: true, pending: true });
    expect(view).not.toHaveProperty('secretEnc');
    expect(onChange).toHaveBeenCalled();

    const stored = db.getServer(view.id)!;
    expect(stored.record.secretEnc).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(await repo.secretsFor(stored.record)).toEqual({
      password: 'hunter2',
      privateKey: null,
      passphrase: null,
    });

    const [entry] = db.outboxBatch(10);
    expect(entry).toMatchObject({ baseVersion: 0, record: { id: view.id } });
  });

  it('requires a secret on create', async () => {
    await expect(repo.create(form({ password: '' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { password: ['Password is required'] } },
    });
  });

  it('rejects text that is not a private key', async () => {
    const err = await repo
      .create(form({ authType: 'key', password: undefined, privateKey: 'PuTTY-User-Key-File-3' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopError);
    expect((err as DesktopError).details).toMatchObject({ fieldErrors: { privateKey: [expect.any(String)] } });
  });

  it('keeps the saved secret when the field is left empty on edit', async () => {
    const { id } = await repo.create(form());
    await repo.update(id, form({ name: 'web-renamed', password: '' }));
    const record = db.getServer(id)!.record;
    expect(record.name).toBe('web-renamed');
    expect((await repo.secretsFor(record)).password).toBe('hunter2');
  });

  it('needs a new secret when switching auth type', async () => {
    const { id } = await repo.create(form());
    await expect(
      repo.update(id, form({ authType: 'key', password: undefined })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await repo.update(id, form({ authType: 'key', privateKey: KEY, passphrase: 'pp' }));
    const secrets = await repo.secretsFor(db.getServer(id)!.record);
    expect(secrets).toEqual({ password: null, privateKey: KEY, passphrase: 'pp' });
  });

  it('forgets the host key when host or port changes', async () => {
    const { id } = await repo.create(form());
    repo.markConnected(id, 'SHA256:abc');
    expect(db.getServer(id)!.record.hostKeyFingerprint).toBe('SHA256:abc');

    await repo.update(id, form({ name: 'renamed' }));
    expect(db.getServer(id)!.record.hostKeyFingerprint).toBe('SHA256:abc');
    await repo.update(id, form({ port: 2222 }));
    expect(db.getServer(id)!.record.hostKeyFingerprint).toBeNull();
  });

  it('duplicates with secrets re-encrypted for the new id', async () => {
    const { id } = await repo.create(form());
    const copy = await repo.duplicate(id);
    expect(copy.id).not.toBe(id);
    expect(copy.name).toBe('web-1 (copy)');
    const record = db.getServer(copy.id)!.record;
    expect((await repo.secretsFor(record)).password).toBe('hunter2');
  });

  it('moves deleted servers to the trash and restores them', async () => {
    const { id } = await repo.create(form());
    repo.remove(id);
    expect(repo.list()).toHaveLength(0);
    expect(repo.listTrash().map((s) => s.id)).toEqual([id]);
    repo.restore(id);
    expect(repo.list().map((s) => s.id)).toEqual([id]);
  });

  it('does not touch clientUpdatedAt when marking a connection', async () => {
    const { id } = await repo.create(form());
    const before = db.getServer(id)!.record.clientUpdatedAt;
    await new Promise((r) => setTimeout(r, 5));
    repo.markConnected(id, null);
    const after = db.getServer(id)!.record;
    expect(after.clientUpdatedAt).toBe(before);
    expect(after.lastConnectedAt).not.toBeNull();
  });
});

describe('LocalDb outbox', () => {
  const synced = (id: string, version: number, name = 'from-api'): SyncedServer => ({
    id,
    name,
    host: 'h',
    port: 22,
    username: 'u',
    authType: 'password',
    secretEnc: null,
    passphraseEnc: null,
    hostKeyFingerprint: null,
    tags: [],
    notes: null,
    lastConnectedAt: null,
    clientUpdatedAt: new Date().toISOString(),
    deletedAt: null,
    version,
    seq: version,
    updatedAt: new Date().toISOString(),
  });

  it('collapses several offline edits into one change with the original base version', async () => {
    const { id } = await repo.create(form());
    const [first] = db.outboxBatch(10);
    db.applyPushResult(first!.mutationId, synced(id, 1, 'web-1'));
    expect(db.pendingCount()).toBe(0);

    await repo.update(id, form({ name: 'a' }));
    await repo.update(id, form({ name: 'b' }));
    const batch = db.outboxBatch(10);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ baseVersion: 1, record: { name: 'b' } });
  });

  it('keeps a newer local edit made while a push was in flight', async () => {
    const { id } = await repo.create(form());
    const [inFlight] = db.outboxBatch(10);
    await repo.update(id, form({ name: 'edited-during-push' }));

    db.applyPushResult(inFlight!.mutationId, synced(id, 1, 'web-1'));

    const local = db.getServer(id)!;
    expect(local.record.name).toBe('edited-during-push');
    expect(local.pending).toBe(true);
    expect(db.outboxBatch(10)[0]!.baseVersion).toBe(1);
  });

  it('does not overwrite pending local edits with pulled data', async () => {
    const { id } = await repo.create(form({ name: 'local' }));
    db.applyRemote([synced(id, 3, 'remote')], []);
    expect(db.getServer(id)!.record.name).toBe('local');

    const other = crypto.randomUUID();
    db.applyRemote([synced(other, 2)], []);
    expect(db.getServer(other)).toMatchObject({ version: 2, pending: false });

    db.applyRemote([], [other]);
    expect(db.getServer(other)).toBeNull();
  });

  it('clears unreadable secrets after a vault key change', async () => {
    const { id } = await repo.create(form());
    db.clearAllSecrets();
    expect(db.getServer(id)!.record.secretEnc).toBeNull();
  });
});
