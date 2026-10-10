import { decryptString, encryptString, serverSecretAad } from '@serverdeck/shared';
import { DesktopError } from './errors';

type SecretField = 'secret' | 'passphrase';

/** Holds the vault key in main-process memory only. */
export class Vault {
  private key: Uint8Array | null = null;

  set(key: Uint8Array): void {
    this.key = key;
  }

  clear(): void {
    this.key?.fill(0);
    this.key = null;
  }

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  /** Copy of the key for persisting to the keychain. */
  exportKey(): Uint8Array {
    return new Uint8Array(this.requireKey());
  }

  encrypt(serverId: string, field: SecretField, plaintext: string): Promise<string> {
    return encryptString(this.requireKey(), plaintext, serverSecretAad(serverId, field));
  }

  decrypt(serverId: string, field: SecretField, payload: string): Promise<string> {
    return decryptString(this.requireKey(), payload, serverSecretAad(serverId, field));
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new DesktopError('VAULT_LOCKED', 'Please log in again to unlock your vault.');
    return this.key;
  }
}
