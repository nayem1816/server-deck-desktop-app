import { randomUUID } from 'node:crypto';
import {
  serverFormSchema,
  type ServerForm,
  type ServerRecord,
  type ServerView,
} from '@serverdeck/shared';
import { DesktopError, fieldError } from './errors';
import type { LocalDb, LocalServer } from './localdb';
import type { Vault } from './vault';

export const TRASH_DAYS = 30;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export function toView(server: LocalServer): ServerView {
  const r = server.record;
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    authType: r.authType,
    hasSecret: r.secretEnc !== null,
    hasPassphrase: r.passphraseEnc !== null,
    hostKeyFingerprint: r.hostKeyFingerprint,
    tags: r.tags,
    notes: r.notes,
    lastConnectedAt: r.lastConnectedAt,
    updatedAt: r.clientUpdatedAt,
    deletedAt: r.deletedAt,
    pending: server.pending,
  };
}

export interface PlainSecrets {
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
}

/** Server CRUD on the local database. Every change goes through the outbox (spec 5.2). */
export class ServerRepo {
  constructor(
    private readonly db: () => LocalDb,
    private readonly vault: Vault,
    /** Called after every local change (UI refresh + schedule a push). */
    private readonly onChange: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): ServerView[] {
    return this.db()
      .listServers()
      .filter((s) => s.record.deletedAt === null)
      .map(toView);
  }

  listTrash(): ServerView[] {
    const cutoff = this.now().getTime() - TRASH_DAYS * 24 * 3600 * 1000;
    return this.db()
      .listServers()
      .filter((s) => s.record.deletedAt !== null && Date.parse(s.record.deletedAt) > cutoff)
      .map(toView);
  }

  get(id: string): LocalServer {
    const server = this.db().getServer(id);
    if (!server) throw new DesktopError('NOT_FOUND', 'This server no longer exists.');
    return server;
  }

  async create(form: ServerForm): Promise<ServerView> {
    const record = await this.buildRecord(randomUUID(), form, null);
    return this.save(record);
  }

  async update(id: string, form: ServerForm): Promise<ServerView> {
    const existing = this.get(id).record;
    return this.save(await this.buildRecord(id, form, existing));
  }

  async duplicate(id: string): Promise<ServerView> {
    const source = this.get(id).record;
    const copyId = randomUUID();
    // Secrets are bound to their server id (AAD), so re-encrypt them for the copy.
    const reencrypt = async (field: 'secret' | 'passphrase', value: string | null) =>
      value === null
        ? null
        : this.vault.encrypt(copyId, field, await this.vault.decrypt(source.id, field, value));

    return this.save({
      ...source,
      id: copyId,
      name: `${source.name} (copy)`.slice(0, 100),
      secretEnc: await reencrypt('secret', source.secretEnc),
      passphraseEnc: await reencrypt('passphrase', source.passphraseEnc),
      lastConnectedAt: null,
      deletedAt: null,
      clientUpdatedAt: this.now().toISOString(),
    });
  }

  remove(id: string): void {
    const record = this.get(id).record;
    const now = this.now().toISOString();
    this.save({ ...record, deletedAt: now, clientUpdatedAt: now });
  }

  restore(id: string): void {
    const record = this.get(id).record;
    this.save({ ...record, deletedAt: null, clientUpdatedAt: this.now().toISOString() });
  }

  /** Connection metadata; deliberately doesn't change clientUpdatedAt (D-012). */
  markConnected(id: string, fingerprint: string | null): void {
    const record = this.get(id).record;
    this.save({
      ...record,
      lastConnectedAt: this.now().toISOString(),
      hostKeyFingerprint: fingerprint ?? record.hostKeyFingerprint,
    });
  }

  /** A host key accepted during "Test connection". */
  setFingerprint(id: string, fingerprint: string): void {
    const record = this.get(id).record;
    if (record.hostKeyFingerprint !== fingerprint) this.save({ ...record, hostKeyFingerprint: fingerprint });
  }

  /** Plain secrets for an SSH connection. Never sent to the renderer. */
  async secretsFor(record: ServerRecord): Promise<PlainSecrets> {
    const secret = record.secretEnc
      ? await this.vault.decrypt(record.id, 'secret', record.secretEnc)
      : null;
    const passphrase = record.passphraseEnc
      ? await this.vault.decrypt(record.id, 'passphrase', record.passphraseEnc)
      : null;
    return {
      password: record.authType === 'password' ? secret : null,
      privateKey: record.authType === 'key' ? secret : null,
      passphrase,
    };
  }

  /** Imports records with plain secrets (from an export file) as new servers. */
  async importPlain(
    items: { record: Omit<ServerRecord, 'secretEnc' | 'passphraseEnc'>; secrets: PlainSecrets }[],
  ): Promise<number> {
    for (const { record, secrets } of items) {
      const id = randomUUID();
      const secret = secrets.password ?? secrets.privateKey;
      this.db().saveLocal({
        ...record,
        id,
        secretEnc: secret ? await this.vault.encrypt(id, 'secret', secret) : null,
        passphraseEnc: secrets.passphrase
          ? await this.vault.encrypt(id, 'passphrase', secrets.passphrase)
          : null,
        deletedAt: null,
        clientUpdatedAt: this.now().toISOString(),
      });
    }
    if (items.length > 0) this.onChange();
    return items.length;
  }

  private save(record: ServerRecord): ServerView {
    this.db().saveLocal(record);
    this.onChange();
    return toView(this.get(record.id));
  }

  /** Validates the form, encrypts new secrets, and keeps saved ones when fields are left empty. */
  private async buildRecord(
    id: string,
    input: ServerForm,
    existing: ServerRecord | null,
  ): Promise<ServerRecord> {
    const form = serverFormSchema.parse(input);
    const sameAuth = existing?.authType === form.authType;
    const secretField = form.authType === 'password' ? 'password' : 'privateKey';
    const newSecret = form.authType === 'password' ? form.password : form.privateKey?.trim();

    let secretEnc = sameAuth ? existing.secretEnc : null;
    let passphraseEnc = sameAuth && form.authType === 'key' ? existing.passphraseEnc : null;

    if (newSecret) {
      if (form.authType === 'key' && !PRIVATE_KEY_PATTERN.test(newSecret)) {
        throw fieldError(
          'privateKey',
          "This doesn't look like an OpenSSH or PEM private key. PuTTY .ppk files aren't supported.",
        );
      }
      secretEnc = await this.vault.encrypt(id, 'secret', newSecret);
    }
    if (form.authType === 'key' && form.passphrase) {
      passphraseEnc = await this.vault.encrypt(id, 'passphrase', form.passphrase);
    }
    if (!secretEnc) {
      throw fieldError(
        secretField,
        form.authType === 'password' ? 'Password is required' : 'Private key is required',
      );
    }

    const endpointChanged =
      existing !== null && (existing.host !== form.host || existing.port !== form.port);

    return {
      id,
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      authType: form.authType,
      secretEnc,
      passphraseEnc,
      // A different host means a different host key; verify again on next connect.
      hostKeyFingerprint: endpointChanged ? null : (existing?.hostKeyFingerprint ?? null),
      tags: [...new Set(form.tags)],
      notes: form.notes?.trim() ? form.notes.trim() : null,
      lastConnectedAt: existing?.lastConnectedAt ?? null,
      clientUpdatedAt: this.now().toISOString(),
      deletedAt: existing?.deletedAt ?? null,
    };
  }
}
