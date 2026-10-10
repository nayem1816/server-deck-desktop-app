import mongoose, { type ClientSession } from 'mongoose';
import type {
  PullResponse,
  PushChange,
  PushResult,
  ServerRecord,
  SyncedServer,
} from '@serverdeck/shared';
import { TRASH_RETENTION_DAYS } from '../config';
import { AppError, notFound } from '../lib/errors';
import { ProcessedMutation, Server, ServerHistory, type ServerDoc } from '../models';
import { nextSyncSeq } from './mappers';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toRecord(doc: ServerDoc): ServerRecord {
  return {
    id: doc._id,
    name: doc.name,
    host: doc.host,
    port: doc.port,
    username: doc.username,
    authType: doc.authType,
    secretEnc: doc.secretEnc,
    passphraseEnc: doc.passphraseEnc,
    hostKeyFingerprint: doc.hostKeyFingerprint,
    tags: doc.tags,
    notes: doc.notes,
    lastConnectedAt: iso(doc.lastConnectedAt),
    clientUpdatedAt: doc.clientUpdatedAt.toISOString(),
    deletedAt: iso(doc.deletedAt),
  };
}

export function toSynced(doc: ServerDoc): SyncedServer {
  return { ...toRecord(doc), version: doc.version, seq: doc.seq, updatedAt: doc.updatedAt.toISOString() };
}

/** User-edited content. Connection metadata is merged separately (D-012). */
function contentFields(record: ServerRecord) {
  return {
    name: record.name,
    host: record.host,
    port: record.port,
    username: record.username,
    authType: record.authType,
    secretEnc: record.secretEnc,
    passphraseEnc: record.passphraseEnc,
    tags: record.tags,
    notes: record.notes,
    clientUpdatedAt: new Date(record.clientUpdatedAt),
    deletedAt: record.deletedAt ? new Date(record.deletedAt) : null,
  };
}

function sameContent(a: ServerRecord, b: ServerRecord): boolean {
  return (
    a.name === b.name &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.authType === b.authType &&
    a.secretEnc === b.secretEnc &&
    a.passphraseEnc === b.passphraseEnc &&
    a.notes === b.notes &&
    a.deletedAt === b.deletedAt &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

function laterDate(a: string | null, b: string | null): Date | null {
  if (!a) return b ? new Date(b) : null;
  if (!b) return new Date(a);
  return new Date(Date.parse(a) > Date.parse(b) ? a : b);
}

/**
 * lastConnectedAt: newest wins. Fingerprint: the incoming one, unless the client didn't know
 * one for the same host:port (then keep ours).
 */
function mergedMeta(current: ServerRecord, incoming: ServerRecord, winner: ServerRecord) {
  const sameEndpoint = winner.host === current.host && winner.port === current.port;
  const incomingEndpoint = winner.host === incoming.host && winner.port === incoming.port;
  let hostKeyFingerprint = winner.hostKeyFingerprint;
  if (sameEndpoint && incomingEndpoint) {
    hostKeyFingerprint = incoming.hostKeyFingerprint ?? current.hostKeyFingerprint;
  }
  return {
    lastConnectedAt: laterDate(current.lastConnectedAt, incoming.lastConnectedAt),
    hostKeyFingerprint,
  };
}

async function saveHistory(
  userId: string,
  serverId: string,
  snapshot: ServerRecord,
  reason: 'conflict' | 'restore',
  session: ClientSession,
) {
  await ServerHistory.create([{ userId, serverId, snapshot, reason }], { session });
}

async function applyChange(userId: string, change: PushChange, session: ClientSession): Promise<PushResult> {
  const { mutationId, baseVersion, server: incoming } = change;
  const existing = await Server.findById(incoming.id).session(session).lean();

  if (existing && existing.userId !== userId) {
    return {
      status: 'rejected',
      mutationId,
      id: incoming.id,
      error: { code: 'ID_CONFLICT', message: 'This server id belongs to another account' },
    };
  }

  if (!existing) {
    const seq = await nextSyncSeq(userId, session);
    const [created] = await Server.create(
      [
        {
          _id: incoming.id,
          userId,
          ...contentFields(incoming),
          lastConnectedAt: incoming.lastConnectedAt ? new Date(incoming.lastConnectedAt) : null,
          hostKeyFingerprint: incoming.hostKeyFingerprint,
          version: 1,
          seq,
        },
      ],
      { session },
    );
    return { status: 'applied', mutationId, id: incoming.id, conflict: false, server: toSynced(created!.toObject()) };
  }

  const current = toRecord(existing);
  const write = async (winner: ServerRecord) => {
    const seq = await nextSyncSeq(userId, session);
    const updated = await Server.findOneAndUpdate(
      { _id: incoming.id, userId },
      {
        $set: { ...contentFields(winner), ...mergedMeta(current, incoming, winner), seq, purgedAt: null },
        $inc: { version: 1 },
      },
      { new: true, session },
    ).lean();
    return toSynced(updated!);
  };

  // Normal edit, or a purged server being brought back by a device that still had it.
  if (existing.version === baseVersion || existing.purgedAt) {
    return { status: 'applied', mutationId, id: incoming.id, conflict: false, server: await write(incoming) };
  }

  // Based on an old version, but nothing the user edits differs: only merge metadata.
  if (sameContent(current, incoming)) {
    const meta = mergedMeta(current, incoming, current);
    const unchanged =
      iso(meta.lastConnectedAt) === current.lastConnectedAt &&
      meta.hostKeyFingerprint === current.hostKeyFingerprint;
    const server = unchanged ? toSynced(existing) : await write(current);
    return { status: 'applied', mutationId, id: incoming.id, conflict: false, server };
  }

  // Real conflict: newer edit (device clock) wins, the other copy goes to history (D-012).
  if (Date.parse(incoming.clientUpdatedAt) > existing.clientUpdatedAt.getTime()) {
    await saveHistory(userId, incoming.id, current, 'conflict', session);
    return { status: 'applied', mutationId, id: incoming.id, conflict: true, server: await write(incoming) };
  }
  await saveHistory(userId, incoming.id, incoming, 'conflict', session);
  return { status: 'conflict_lost', mutationId, id: incoming.id, conflict: true, server: await write(current) };
}

export function createSyncService() {
  return {
    async push(userId: string, changes: PushChange[]): Promise<PushResult[]> {
      const results: PushResult[] = [];
      // One transaction per change, so one bad change can't block the rest of the batch.
      for (const change of changes) {
        const key = `${userId}:${change.mutationId}`;
        let result: PushResult | undefined;
        await mongoose.connection.transaction(async (session) => {
          const done = await ProcessedMutation.findById(key).session(session).lean();
          if (done) {
            result = done.result as unknown as PushResult;
            return;
          }
          result = await applyChange(userId, change, session);
          if (result.status !== 'rejected') {
            await ProcessedMutation.create([{ _id: key, result }], { session });
          }
        });
        results.push(result!);
      }
      return results;
    },

    async pull(userId: string, since: number, limit: number): Promise<PullResponse> {
      const docs = await Server.find({ userId, seq: { $gt: since } })
        .sort({ seq: 1 })
        .limit(limit + 1)
        .lean();
      const page = docs.slice(0, limit);
      return {
        servers: page.filter((d) => !d.purgedAt).map(toSynced),
        purgedIds: page.filter((d) => d.purgedAt).map((d) => d._id),
        cursor: page.at(-1)?.seq ?? since,
        hasMore: docs.length > limit,
      };
    },

    async listTrash(userId: string, now = new Date()): Promise<SyncedServer[]> {
      const docs = await Server.find({
        userId,
        purgedAt: null,
        deletedAt: { $gt: new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000) },
      })
        .sort({ deletedAt: -1 })
        .lean();
      return docs.map(toSynced);
    },

    async restoreFromTrash(userId: string, id: string): Promise<SyncedServer> {
      let result: SyncedServer | undefined;
      await mongoose.connection.transaction(async (session) => {
        const doc = await Server.findOne({ _id: id, userId, purgedAt: null, deletedAt: { $ne: null } })
          .session(session)
          .lean();
        if (!doc) throw notFound('Server in trash');
        const seq = await nextSyncSeq(userId, session);
        const updated = await Server.findOneAndUpdate(
          { _id: id, userId },
          { $set: { deletedAt: null, clientUpdatedAt: new Date(), seq }, $inc: { version: 1 } },
          { new: true, session },
        ).lean();
        result = toSynced(updated!);
      });
      return result!;
    },

    async listHistory(userId: string) {
      const entries = await ServerHistory.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
      return entries.map((e) => ({
        id: e._id,
        serverId: e.serverId,
        name: String(e.snapshot.name ?? ''),
        host: String(e.snapshot.host ?? ''),
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      }));
    },

    /** Puts a history snapshot back as the current version; the replaced copy goes to history. */
    async restoreFromHistory(userId: string, historyId: string): Promise<SyncedServer> {
      let result: SyncedServer | undefined;
      await mongoose.connection.transaction(async (session) => {
        const entry = await ServerHistory.findOne({ _id: historyId, userId }).session(session).lean();
        if (!entry) throw notFound('History entry');
        const snapshot = entry.snapshot as unknown as ServerRecord;
        const current = await Server.findById(entry.serverId).session(session).lean();
        if (current && current.userId !== userId) throw new AppError(404, 'NOT_FOUND', 'Server not found');
        if (current && !current.purgedAt) {
          await saveHistory(userId, entry.serverId, toRecord(current), 'restore', session);
        }
        const seq = await nextSyncSeq(userId, session);
        const restored = { ...snapshot, deletedAt: null, clientUpdatedAt: new Date().toISOString() };
        const updated = await Server.findOneAndUpdate(
          { _id: entry.serverId },
          {
            $set: {
              userId,
              ...contentFields(restored),
              hostKeyFingerprint: snapshot.hostKeyFingerprint,
              lastConnectedAt: current?.lastConnectedAt ?? null,
              purgedAt: null,
              seq,
            },
            $inc: { version: 1 },
          },
          { new: true, upsert: true, session },
        ).lean();
        await ServerHistory.deleteOne({ _id: historyId }, { session });
        result = toSynced(updated!);
      });
      return result!;
    },

    /**
     * Clears servers that have been in the trash for 30 days, keeping a tombstone so offline
     * devices still learn about the deletion (D-015).
     */
    async purgeTrash(now = new Date()): Promise<number> {
      const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000);
      const expired = await Server.find({ purgedAt: null, deletedAt: { $lte: cutoff } }, { _id: 1, userId: 1 }).lean();
      for (const { _id, userId } of expired) {
        await mongoose.connection.transaction(async (session) => {
          const seq = await nextSyncSeq(userId, session);
          await Server.updateOne(
            { _id, purgedAt: null },
            {
              $set: {
                purgedAt: now,
                name: '',
                host: '',
                username: '',
                secretEnc: null,
                passphraseEnc: null,
                hostKeyFingerprint: null,
                tags: [],
                notes: null,
                seq,
              },
              $inc: { version: 1 },
            },
            { session },
          );
        });
      }
      return expired.length;
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
