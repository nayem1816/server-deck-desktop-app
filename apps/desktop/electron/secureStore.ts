import fs from 'node:fs';
import path from 'node:path';
import type { User } from '@serverdeck/shared';

/** What "stay logged in" keeps between launches (D-017). Encrypted with the OS keychain. */
export interface PersistedSession {
  user: User;
  refreshToken: string;
  /** Base64 vault key. */
  vaultKey: string;
  vaultKeyVersion: number;
}

export interface StringCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class SecureStore {
  constructor(
    private readonly file: string,
    private readonly cipher: StringCipher,
  ) {}

  load(): PersistedSession | null {
    if (!this.cipher.isAvailable() || !fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))) as PersistedSession;
    } catch {
      // Unreadable (other OS user, keychain reset): treat as logged out.
      this.clear();
      return null;
    }
  }

  /** Without an OS keychain nothing is written, so the user logs in each launch. */
  save(session: PersistedSession): void {
    if (!this.cipher.isAvailable()) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(session)));
    fs.renameSync(tmp, this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
