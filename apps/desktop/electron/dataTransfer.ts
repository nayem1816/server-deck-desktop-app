import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  decryptExport,
  encryptExport,
  serverRecordSchema,
  VaultCryptoError,
  type EncryptedExport,
} from '@serverdeck/shared';
import { DesktopError, fieldError } from './errors';
import type { ServerRepo } from './servers';

const exportedServerSchema = z.object({
  record: serverRecordSchema.omit({ secretEnc: true, passphraseEnc: true }),
  secrets: z.object({
    password: z.string().nullable(),
    privateKey: z.string().nullable(),
    passphrase: z.string().nullable(),
  }),
});
const exportPayloadSchema = z.object({
  exportedAt: z.string(),
  servers: z.array(exportedServerSchema),
});

const encryptedFileSchema = z.object({
  format: z.literal('serverdeck-export'),
  version: z.literal(1),
  kdfSalt: z.string(),
  kdfParams: z.object({
    algorithm: z.literal('argon2id'),
    memoryKiB: z.number(),
    iterations: z.number(),
    parallelism: z.number(),
  }),
  payload: z.string(),
});

export const MIN_PASSPHRASE = 8;

export interface FileDialogs {
  chooseSavePath(defaultName: string): Promise<string | null>;
  chooseOpenPath(): Promise<string | null>;
}

/** Settings → Export / Import (D-019). The file holds plain secrets, encrypted with a passphrase. */
export class DataTransfer {
  constructor(
    private readonly servers: ServerRepo,
    private readonly dialogs: FileDialogs,
  ) {}

  async exportToFile(passphrase: string): Promise<{ path: string } | null> {
    if (passphrase.length < MIN_PASSPHRASE) {
      throw fieldError('passphrase', `Use at least ${MIN_PASSPHRASE} characters`);
    }
    const file = await this.dialogs.chooseSavePath(
      `serverdeck-export-${new Date().toISOString().slice(0, 10)}.json`,
    );
    if (!file) return null;

    const items = [];
    for (const view of this.servers.list()) {
      const { record } = this.servers.get(view.id);
      const { secretEnc: _s, passphraseEnc: _p, ...rest } = record;
      items.push({ record: rest, secrets: await this.servers.secretsFor(record) });
    }
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), servers: items });
    const encrypted = await encryptExport(passphrase, payload);
    await fs.writeFile(file, JSON.stringify(encrypted, null, 2), 'utf8');
    return { path: file };
  }

  async importFromFile(passphrase: string): Promise<{ imported: number } | null> {
    const file = await this.dialogs.chooseOpenPath();
    if (!file) return null;

    let encrypted: EncryptedExport;
    try {
      encrypted = encryptedFileSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      throw new DesktopError('INVALID_FILE', 'This is not a ServerDeck export file.');
    }

    let plain: string;
    try {
      plain = await decryptExport(passphrase, encrypted);
    } catch (err) {
      if (err instanceof VaultCryptoError) {
        throw fieldError('passphrase', 'Wrong passphrase, or the file is damaged.');
      }
      throw err;
    }
    const { servers } = exportPayloadSchema.parse(JSON.parse(plain));
    return { imported: await this.servers.importPlain(servers) };
  }
}
