import type { ErrorCode } from '@serverdeck/shared';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (message = 'Please log in again') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong');

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
