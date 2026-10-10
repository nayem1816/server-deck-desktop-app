import { describe, expect, it } from 'vitest';
import {
  createAccountVault,
  decryptString,
  deriveAccountKeys,
  encryptString,
  generateRecoveryKey,
  generateSalt,
  generateVaultKey,
  parseRecoveryKey,
  rewrapVaultForPassword,
  serverSecretAad,
  unwrapVaultKey,
  unwrapVaultKeyWithRecovery,
  VaultCryptoError,
  type KdfParams,
} from './crypto';
import { cipherTextSchema, keyB64Schema, saltB64Schema } from './schemas/common';

// Light params keep the suite fast; production uses DEFAULT_KDF_PARAMS.
const FAST: KdfParams = { algorithm: 'argon2id', memoryKiB: 1024, iterations: 1, parallelism: 1 };

describe('deriveAccountKeys', () => {
  it('is deterministic for the same password and salt', async () => {
    const salt = generateSalt();
    const a = await deriveAccountKeys('correct horse', salt, FAST);
    const b = await deriveAccountKeys('correct horse', salt, FAST);
    expect(a.authKey).toBe(b.authKey);
    expect(a.wrapKey).toEqual(b.wrapKey);
  });

  it('gives different keys for a different password or salt', async () => {
    const salt = generateSalt();
    const a = await deriveAccountKeys('correct horse', salt, FAST);
    const b = await deriveAccountKeys('correct horsE', salt, FAST);
    const c = await deriveAccountKeys('correct horse', generateSalt(), FAST);
    expect(a.authKey).not.toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
  });

  it('never exposes the wrap key through the auth key', async () => {
    const { authKey, wrapKey } = await deriveAccountKeys('pw', generateSalt(), FAST);
    expect(Buffer.from(authKey, 'base64').equals(Buffer.from(wrapKey))).toBe(false);
  });

  it('produces values the API schemas accept', async () => {
    const salt = generateSalt();
    expect(saltB64Schema.safeParse(salt).success).toBe(true);
    const { authKey } = await deriveAccountKeys('pw', salt, FAST);
    expect(keyB64Schema.safeParse(authKey).success).toBe(true);
  });
});

describe('secret encryption', () => {
  const id = '6f1c9a52-6a43-4d4e-9d0c-0f6d6b1a2b3c';

  it('round-trips a secret', async () => {
    const key = generateVaultKey();
    const payload = await encryptString(key, 'hunter2 ✓', serverSecretAad(id, 'secret'));
    expect(cipherTextSchema.safeParse(payload).success).toBe(true);
    expect(await decryptString(key, payload, serverSecretAad(id, 'secret'))).toBe('hunter2 ✓');
  });

  it('uses a fresh IV each time', async () => {
    const key = generateVaultKey();
    const aad = serverSecretAad(id, 'secret');
    expect(await encryptString(key, 'same', aad)).not.toBe(await encryptString(key, 'same', aad));
  });

  it('rejects the wrong key', async () => {
    const payload = await encryptString(generateVaultKey(), 'x', 'ctx');
    await expect(decryptString(generateVaultKey(), payload, 'ctx')).rejects.toBeInstanceOf(
      VaultCryptoError,
    );
  });

  it('rejects a secret moved to another server or field', async () => {
    const key = generateVaultKey();
    const payload = await encryptString(key, 'x', serverSecretAad(id, 'secret'));
    await expect(decryptString(key, payload, serverSecretAad(id, 'passphrase'))).rejects.toThrow();
    const other = '00000000-0000-4000-8000-000000000000';
    await expect(decryptString(key, payload, serverSecretAad(other, 'secret'))).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const key = generateVaultKey();
    const payload = await encryptString(key, 'secret', 'ctx');
    const [v, iv, ct] = payload.split(':');
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    await expect(
      decryptString(key, `${v}:${iv}:${bytes.toString('base64')}`, 'ctx'),
    ).rejects.toThrow();
  });
});

describe('recovery key', () => {
  it('has 8 groups of 4 Crockford characters', () => {
    expect(generateRecoveryKey()).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('parses regardless of case, spaces and look-alike letters', () => {
    const key = generateRecoveryKey();
    const messy = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    expect(parseRecoveryKey(messy)).toEqual(parseRecoveryKey(key));
  });

  it('rejects wrong length and invalid characters', () => {
    expect(() => parseRecoveryKey('ABCD')).toThrow(VaultCryptoError);
    expect(() => parseRecoveryKey('U'.repeat(32))).toThrow(VaultCryptoError);
  });
});

describe('account vault flows', () => {
  it('unlocks with the password after sign-up', async () => {
    const vault = await createAccountVault('my password', FAST);
    const { authKey, wrapKey } = await deriveAccountKeys('my password', vault.kdfSalt, FAST);
    expect(authKey).toBe(vault.authKey);
    expect(await unwrapVaultKey(wrapKey, vault.vaultKeyWrapped)).toEqual(vault.vaultKey);
  });

  it('unlocks with the recovery key', async () => {
    const vault = await createAccountVault('my password', FAST);
    const recovered = await unwrapVaultKeyWithRecovery(vault.recoveryKey, vault.vaultKeyRecovery);
    expect(recovered).toEqual(vault.vaultKey);
    await expect(
      unwrapVaultKeyWithRecovery(generateRecoveryKey(), vault.vaultKeyRecovery),
    ).rejects.toThrow();
  });

  it('keeps old secrets readable after a password change', async () => {
    const vault = await createAccountVault('old password', FAST);
    const secret = await encryptString(vault.vaultKey, 'ssh-pass', 'ctx');

    const rewrapped = await rewrapVaultForPassword('new password', vault.vaultKey, FAST);
    const { wrapKey } = await deriveAccountKeys('new password', rewrapped.kdfSalt, FAST);
    const vaultKey = await unwrapVaultKey(wrapKey, rewrapped.vaultKeyWrapped);

    expect(await decryptString(vaultKey, secret, 'ctx')).toBe('ssh-pass');
    expect(rewrapped.authKey).not.toBe(vault.authKey);
  });
});
