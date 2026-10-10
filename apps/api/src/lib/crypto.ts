import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** authKey is already a 256-bit derived key, so moderate argon2 cost is enough. */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashAuthKey(authKey: string): Promise<string> {
  return hash(authKey, ARGON2_OPTIONS);
}

export async function verifyAuthKey(authHash: string, authKey: string): Promise<boolean> {
  try {
    return await verify(authHash, authKey);
  } catch {
    return false;
  }
}

/** A real hash of a random value, used so unknown-email logins take the same time. */
let dummyHash: Promise<string> | undefined;
export async function burnVerifyTime(authKey: string): Promise<void> {
  dummyHash ??= hashAuthKey(randomBytes(32).toString('base64'));
  await verifyAuthKey(await dummyHash, authKey);
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string, value: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function generateResetCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
