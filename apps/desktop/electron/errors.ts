import { ZodError } from 'zod';
import { VaultCryptoError, type DesktopErrorShape } from '@serverdeck/shared';

export class DesktopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DesktopError';
  }
}

export const offlineError = () =>
  new DesktopError(
    'OFFLINE',
    "Can't reach the ServerDeck server. Check your internet connection and try again.",
  );

export const signedOutError = () => new DesktopError('UNAUTHORIZED', 'Please log in again.');

export function fieldError(field: string, message: string): DesktopError {
  return new DesktopError('VALIDATION_ERROR', message, {
    formErrors: [],
    fieldErrors: { [field]: [message] },
  });
}

export function toErrorShape(err: unknown): DesktopErrorShape {
  if (err instanceof DesktopError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid. Check them and try again.',
      details: err.flatten(),
    };
  }
  if (err instanceof VaultCryptoError) {
    if (err.code === 'INVALID_RECOVERY_KEY') {
      return { code: err.code, message: `${err.message}. Check the key and try again.` };
    }
    return {
      code: err.code,
      message: "A saved secret couldn't be decrypted. Log out and in again, then re-enter it.",
    };
  }
  console.error(err);
  return { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}
