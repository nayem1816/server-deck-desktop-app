/**
 * Client-side vault crypto (spec section 7, with the auth/wrap key split from DECISIONS.md D-002).
 *
 *   masterKey = Argon2id(password, kdfSalt)            — never leaves the device
 *   authKey   = HKDF(masterKey, "auth")  → sent to API  — API stores argon2(authKey)
 *   wrapKey   = HKDF(masterKey, "wrap")  → encrypts the vault key
 *   vaultKey  = random 256-bit key        → encrypts server secrets (AES-256-GCM)
 *
 * Works in Node 20+ and browsers (WebCrypto + hash-wasm), so Electron main and tests share it.
 */
import { argon2id } from 'hash-wasm';

export interface KdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
};

export class VaultCryptoError extends Error {
  constructor(
    public readonly code: 'DECRYPT_FAILED' | 'INVALID_RECOVERY_KEY' | 'INVALID_PAYLOAD',
    message: string,
  ) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

const CIPHER_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** Copies into a plain ArrayBuffer — WebCrypto typings reject SharedArrayBuffer-backed views. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new VaultCryptoError('INVALID_PAYLOAD', 'Invalid base64 data');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateSalt(): string {
  return toBase64(randomBytes(16));
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new ArrayBuffer(32),
      info: toArrayBuffer(textEncoder.encode(info)),
    },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveMasterKey(
  password: string,
  kdfSalt: string,
  params: KdfParams,
): Promise<Uint8Array> {
  return argon2id({
    password: password.normalize('NFKC'),
    salt: fromBase64(kdfSalt),
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
}

export interface AccountKeys {
  /** Base64; sent to the API in place of the password. */
  authKey: string;
  /** Raw key that wraps the vault key. Never sent anywhere. */
  wrapKey: Uint8Array;
}

export async function deriveAccountKeys(
  password: string,
  kdfSalt: string,
  params: KdfParams,
): Promise<AccountKeys> {
  const masterKey = await deriveMasterKey(password, kdfSalt, params);
  try {
    const [auth, wrapKey] = await Promise.all([
      hkdf(masterKey, 'serverdeck/auth/v1'),
      hkdf(masterKey, 'serverdeck/wrap/v1'),
    ]);
    return { authKey: toBase64(auth), wrapKey };
  } finally {
    masterKey.fill(0);
  }
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.byteLength !== KEY_BYTES) {
    throw new VaultCryptoError('INVALID_PAYLOAD', 'Key must be 32 bytes');
  }
  return subtle().importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-256-GCM. Output: "v1:<iv b64>:<ciphertext+tag b64>". `aad` binds the ciphertext to its context. */
export async function encryptBytes(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<string> {
  const key = await importAesKey(keyBytes);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(textEncoder.encode(aad)) },
    key,
    toArrayBuffer(plaintext),
  );
  return `${CIPHER_VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptBytes(
  keyBytes: Uint8Array,
  payload: string,
  aad: string,
): Promise<Uint8Array> {
  const [version, ivB64, ctB64] = payload.split(':');
  if (version !== CIPHER_VERSION || !ivB64 || !ctB64) {
    throw new VaultCryptoError('INVALID_PAYLOAD', 'Unsupported ciphertext format');
  }
  const key = await importAesKey(keyBytes);
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(fromBase64(ivB64)),
        additionalData: toArrayBuffer(textEncoder.encode(aad)),
      },
      key,
      toArrayBuffer(fromBase64(ctB64)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new VaultCryptoError('DECRYPT_FAILED', 'Wrong key or corrupted data');
  }
}

export async function encryptString(keyBytes: Uint8Array, plaintext: string, aad: string) {
  return encryptBytes(keyBytes, textEncoder.encode(plaintext), aad);
}

export async function decryptString(keyBytes: Uint8Array, payload: string, aad: string) {
  return textDecoder.decode(await decryptBytes(keyBytes, payload, aad));
}

const VAULT_KEY_AAD = 'serverdeck/vault-key/v1';

export function wrapVaultKey(wrapKey: Uint8Array, vaultKey: Uint8Array): Promise<string> {
  return encryptBytes(wrapKey, vaultKey, VAULT_KEY_AAD);
}

export function unwrapVaultKey(wrapKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  return decryptBytes(wrapKey, wrapped, VAULT_KEY_AAD);
}

/** AAD for a server secret, so an encrypted value can't be swapped onto another server or field. */
export function serverSecretAad(serverId: string, field: 'secret' | 'passphrase'): string {
  return `serverdeck/server/${serverId}/${field}`;
}

// ---- Recovery key: 20 random bytes as 32 Crockford base32 chars, shown as XXXX-XXXX-… ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = 20;

export function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

export function parseRecoveryKey(input: string): Uint8Array {
  const chars = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (chars.length !== 32) {
    throw new VaultCryptoError('INVALID_RECOVERY_KEY', 'Recovery key must have 32 characters');
  }
  const bytes = new Uint8Array(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of chars) {
    const digit = CROCKFORD.indexOf(char);
    if (digit === -1) {
      throw new VaultCryptoError('INVALID_RECOVERY_KEY', `Invalid character "${char}"`);
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return bytes;
}

/** The recovery key has 160 bits of entropy, so HKDF alone (no Argon2) is enough. */
export function deriveRecoveryWrapKey(recoveryKey: string): Promise<Uint8Array> {
  return hkdf(parseRecoveryKey(recoveryKey), 'serverdeck/recovery/v1');
}

// ---- High-level flows used by the desktop app ----

export interface NewAccountVault {
  authKey: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  vaultKey: Uint8Array;
  vaultKeyWrapped: string;
  vaultKeyRecovery: string;
  recoveryKey: string;
}

export async function createAccountVault(
  password: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<NewAccountVault> {
  const kdfSalt = generateSalt();
  const { authKey, wrapKey } = await deriveAccountKeys(password, kdfSalt, kdfParams);
  const vaultKey = generateVaultKey();
  const recoveryKey = generateRecoveryKey();
  const [vaultKeyWrapped, vaultKeyRecovery] = await Promise.all([
    wrapVaultKey(wrapKey, vaultKey),
    deriveRecoveryWrapKey(recoveryKey).then((key) => wrapVaultKey(key, vaultKey)),
  ]);
  wrapKey.fill(0);
  return { authKey, kdfSalt, kdfParams, vaultKey, vaultKeyWrapped, vaultKeyRecovery, recoveryKey };
}

export async function unwrapVaultKeyWithRecovery(
  recoveryKey: string,
  vaultKeyRecovery: string,
): Promise<Uint8Array> {
  return unwrapVaultKey(await deriveRecoveryWrapKey(recoveryKey), vaultKeyRecovery);
}

export interface RewrappedVault {
  authKey: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  vaultKeyWrapped: string;
}

// ---- Passphrase-encrypted export files (D-019) ----

const EXPORT_AAD = 'serverdeck/export/v1';

export interface EncryptedExport {
  format: 'serverdeck-export';
  version: 1;
  kdfSalt: string;
  kdfParams: KdfParams;
  payload: string;
}

export async function encryptExport(
  passphrase: string,
  plaintext: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<EncryptedExport> {
  const kdfSalt = generateSalt();
  const key = await deriveMasterKey(passphrase, kdfSalt, kdfParams);
  try {
    const payload = await encryptString(key, plaintext, EXPORT_AAD);
    return { format: 'serverdeck-export', version: 1, kdfSalt, kdfParams, payload };
  } finally {
    key.fill(0);
  }
}

export async function decryptExport(passphrase: string, file: EncryptedExport): Promise<string> {
  if (file.format !== 'serverdeck-export' || file.version !== 1) {
    throw new VaultCryptoError('INVALID_PAYLOAD', 'This is not a ServerDeck export file');
  }
  const key = await deriveMasterKey(passphrase, file.kdfSalt, file.kdfParams);
  try {
    return await decryptString(key, file.payload, EXPORT_AAD);
  } finally {
    key.fill(0);
  }
}

/** Password change / reset-with-recovery: same vault key, new password. */
export async function rewrapVaultForPassword(
  newPassword: string,
  vaultKey: Uint8Array,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<RewrappedVault> {
  const kdfSalt = generateSalt();
  const { authKey, wrapKey } = await deriveAccountKeys(newPassword, kdfSalt, kdfParams);
  const vaultKeyWrapped = await wrapVaultKey(wrapKey, vaultKey);
  wrapKey.fill(0);
  return { authKey, kdfSalt, kdfParams, vaultKeyWrapped };
}
