import {
  PUSH_BATCH_LIMIT,
  pullResponseSchema,
  pushResponseSchema,
  type SyncState,
} from '@serverdeck/shared';
import type { ApiClient } from './apiClient';
import { DesktopError } from './errors';
import type { LocalDb } from './localdb';

const CURSOR_KEY = 'syncCursor';
const LAST_SYNC_KEY = 'lastSyncedAt';
/** Stops a runaway loop if a batch keeps coming back unchanged. */
const MAX_PUSH_ROUNDS = 20;

export interface SyncEngineOptions {
  api: ApiClient;
  db: () => LocalDb;
  /** Sync status for the sidebar. */
  onState: (state: SyncState) => void;
  /** Local data changed because of the API (UI should reload). */
  onDataChanged: () => void;
  intervalMs?: number;
  pushDelayMs?: number;
}

/**
 * Push the outbox, then pull changes after the cursor (spec section 5). Runs on start, every
 * 55 s (so a change shows up on other devices within 60 s, D-023), on window focus, and shortly after each local change.
 */
export class SyncEngine {
  private state: SyncState = {
    status: 'signed-out',
    pendingChanges: 0,
    lastSyncedAt: null,
    message: null,
  };
  private running: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;
  private active = false;
  private interval: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SyncEngineOptions) {}

  getState(): SyncState {
    return this.state;
  }

  start(): void {
    this.active = true;
    const db = this.options.db();
    this.setState({
      status: 'syncing',
      pendingChanges: db.pendingCount(),
      lastSyncedAt: db.getMeta(LAST_SYNC_KEY),
      message: null,
    });
    void this.syncNow();
    this.interval = setInterval(() => void this.syncNow(), this.options.intervalMs ?? 55_000);
  }

  stop(): void {
    this.active = false;
    if (this.interval) clearInterval(this.interval);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.interval = null;
    this.pushTimer = null;
    this.setState({ status: 'signed-out', pendingChanges: 0, lastSyncedAt: null, message: null });
  }

  /** After a local edit: show it as pending now, push shortly (edits in a burst share one push). */
  notifyLocalChange(): void {
    if (!this.active) return;
    this.setState({ ...this.state, pendingChanges: this.options.db().pendingCount() });
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncNow(), this.options.pushDelayMs ?? 500);
  }

  /**
   * Resolves when a push + pull round that started after this call has finished (or failed).
   * Calls made during a run share one follow-up run. Never rejects.
   */
  syncNow(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.running) {
      this.followUp ??= this.running.then(() => {
        this.followUp = null;
        return this.syncNow();
      });
      return this.followUp;
    }
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const db = this.options.db();
    this.setState({ ...this.state, status: 'syncing', pendingChanges: db.pendingCount() });
    try {
      const pushed = await this.push(db);
      const pulled = await this.pull(db);
      if (pushed || pulled) this.options.onDataChanged();
      if (!this.active) return;
      const now = new Date().toISOString();
      db.setMeta(LAST_SYNC_KEY, now);
      this.setState({
        status: 'synced',
        pendingChanges: db.pendingCount(),
        lastSyncedAt: now,
        message: null,
      });
    } catch (err) {
      if (!this.active) return;
      const code = err instanceof DesktopError ? err.code : 'INTERNAL';
      const offline = code === 'OFFLINE' || code === 'SERVER_ERROR';
      this.setState({
        ...this.state,
        status: code === 'UNAUTHORIZED' ? 'signed-out' : offline ? 'offline' : 'error',
        pendingChanges: db.pendingCount(),
        message: offline
          ? 'Offline — changes saved, will sync'
          : err instanceof Error
            ? err.message
            : 'Sync failed',
      });
    }
  }

  /** Returns true if the API sent back data that differs from what we pushed. */
  private async push(db: LocalDb): Promise<boolean> {
    let changed = false;
    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      const batch = db.outboxBatch(PUSH_BATCH_LIMIT);
      if (batch.length === 0) break;

      const response = pushResponseSchema.parse(
        await this.options.api.request('/sync/push', {
          method: 'POST',
          body: {
            changes: batch.map((e) => ({
              mutationId: e.mutationId,
              baseVersion: e.baseVersion,
              server: e.record,
            })),
          },
        }),
      );

      for (const result of response.results) {
        if (result.status === 'rejected') {
          console.warn(`Sync rejected ${result.id}: ${result.error.code}`);
          db.dropOutboxEntry(result.id, result.mutationId);
          changed = true;
        } else {
          db.applyPushResult(result.mutationId, result.server);
          if (result.conflict) changed = true;
        }
      }
      if (db.pendingCount() === 0) break;
    }
    return changed;
  }

  private async pull(db: LocalDb): Promise<boolean> {
    let cursor = Number(db.getMeta(CURSOR_KEY) ?? '0');
    let changed = false;
    for (;;) {
      const page = pullResponseSchema.parse(
        await this.options.api.request(`/sync/pull?since=${cursor}`),
      );
      if (page.servers.length > 0 || page.purgedIds.length > 0) {
        db.applyRemote(page.servers, page.purgedIds);
        changed = true;
      }
      cursor = page.cursor;
      db.setMeta(CURSOR_KEY, String(cursor));
      if (!page.hasMore) break;
    }
    return changed;
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.options.onState(state);
  }
}
