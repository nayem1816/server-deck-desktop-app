import { randomUUID } from 'node:crypto';
import type { DatabaseSync as Database } from 'node:sqlite';
import type { ServerRecord, SyncedServer } from '@serverdeck/shared';

export interface LocalServer {
  record: ServerRecord;
  /** Last version confirmed by the API; 0 = never synced. */
  version: number;
  pending: boolean;
}

export interface OutboxEntry {
  mutationId: string;
  baseVersion: number;
  record: ServerRecord;
}

// Loaded at runtime: bundlers strip the node: prefix from static imports, and 'sqlite'
// only exists as node:sqlite.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

interface ServerRow {
  id: string;
  data: string;
  version: number;
  pending: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS servers (
    id      TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
  );
  -- One row per server with unsent changes. The data to send is read from servers at push
  -- time, so several offline edits collapse into one change.
  CREATE TABLE IF NOT EXISTS outbox (
    server_id    TEXT PRIMARY KEY,
    mutation_id  TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * Local copy of the user's servers plus the queue of changes not yet confirmed by the API
 * (spec section 5). One file per account.
 */
export class LocalDb {
  private readonly db: Database;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private toLocal(row: ServerRow): LocalServer {
    return {
      record: JSON.parse(row.data) as ServerRecord,
      version: row.version,
      pending: row.pending === 1,
    };
  }

  listServers(): LocalServer[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.data, s.version, (o.server_id IS NOT NULL) AS pending
         FROM servers s LEFT JOIN outbox o ON o.server_id = s.id`,
      )
      .all() as unknown as ServerRow[];
    return rows.map((row) => this.toLocal(row));
  }

  getServer(id: string): LocalServer | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.data, s.version, (o.server_id IS NOT NULL) AS pending
         FROM servers s LEFT JOIN outbox o ON o.server_id = s.id WHERE s.id = ?`,
      )
      .get(id) as unknown as ServerRow | undefined;
    return row ? this.toLocal(row) : null;
  }

  /** A change made on this device: save it and queue it for push in one step. */
  saveLocal(record: ServerRecord): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT version FROM servers WHERE id = ?').get(record.id) as
        | { version: number }
        | undefined;
      const version = existing?.version ?? 0;
      this.db
        .prepare(
          `INSERT INTO servers (id, data, version) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        )
        .run(record.id, JSON.stringify(record), version);
      // A new mutation id per edit; base version stays the one the first unsent edit started from.
      this.db
        .prepare(
          `INSERT INTO outbox (server_id, mutation_id, base_version, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(server_id) DO UPDATE SET mutation_id = excluded.mutation_id`,
        )
        .run(record.id, randomUUID(), version, new Date().toISOString());
    });
  }

  /** Saves a server-confirmed copy from a pull. Servers with unsent local edits are left alone. */
  applyRemote(servers: SyncedServer[], purgedIds: string[]): void {
    this.transaction(() => {
      const hasPending = this.db.prepare('SELECT 1 FROM outbox WHERE server_id = ?');
      const upsert = this.db.prepare(
        `INSERT INTO servers (id, data, version) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version`,
      );
      for (const server of servers) {
        if (hasPending.get(server.id)) continue;
        upsert.run(server.id, JSON.stringify(toRecord(server)), server.version);
      }
      const remove = this.db.prepare('DELETE FROM servers WHERE id = ?');
      const removeOutbox = this.db.prepare('DELETE FROM outbox WHERE server_id = ?');
      for (const id of purgedIds) {
        remove.run(id);
        removeOutbox.run(id);
      }
    });
  }

  /** The API accepted (or out-voted) a pushed change and returned the authoritative copy. */
  applyPushResult(mutationId: string, server: SyncedServer): void {
    this.transaction(() => {
      const entry = this.db
        .prepare('SELECT mutation_id FROM outbox WHERE server_id = ?')
        .get(server.id) as { mutation_id: string } | undefined;

      if (entry?.mutation_id === mutationId) {
        this.db.prepare('DELETE FROM outbox WHERE server_id = ?').run(server.id);
        this.db
          .prepare('UPDATE servers SET data = ?, version = ? WHERE id = ?')
          .run(JSON.stringify(toRecord(server)), server.version, server.id);
      } else {
        // Edited again while the push was in flight: keep the newer local data, rebase on the
        // version the API now has so the next push isn't seen as a conflict.
        this.db
          .prepare('UPDATE outbox SET base_version = ? WHERE server_id = ?')
          .run(server.version, server.id);
        this.db.prepare('UPDATE servers SET version = ? WHERE id = ?').run(server.version, server.id);
      }
    });
  }

  /** The API refused a change permanently (e.g. ID_CONFLICT); stop retrying it. */
  dropOutboxEntry(serverId: string, mutationId: string): void {
    this.db
      .prepare('DELETE FROM outbox WHERE server_id = ? AND mutation_id = ?')
      .run(serverId, mutationId);
  }

  outboxBatch(limit: number): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT o.mutation_id, o.base_version, s.data FROM outbox o
         JOIN servers s ON s.id = o.server_id ORDER BY o.created_at LIMIT ?`,
      )
      .all(limit) as unknown as { mutation_id: string; base_version: number; data: string }[];
    return rows.map((row) => ({
      mutationId: row.mutation_id,
      baseVersion: row.base_version,
      record: JSON.parse(row.data) as ServerRecord,
    }));
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as unknown as { n: number };
    return row.n;
  }

  /** The vault key changed (reset without recovery key): old ciphertext is unreadable. */
  clearAllSecrets(): void {
    this.transaction(() => {
      const rows = this.db.prepare('SELECT id, data FROM servers').all() as unknown as {
        id: string;
        data: string;
      }[];
      const update = this.db.prepare('UPDATE servers SET data = ? WHERE id = ?');
      for (const row of rows) {
        const record = JSON.parse(row.data) as ServerRecord;
        if (record.secretEnc === null && record.passphraseEnc === null) continue;
        update.run(JSON.stringify({ ...record, secretEnc: null, passphraseEnc: null }), row.id);
      }
    });
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

export function toRecord(server: SyncedServer): ServerRecord {
  const { version: _v, seq: _s, updatedAt: _u, ...record } = server;
  return record;
}
