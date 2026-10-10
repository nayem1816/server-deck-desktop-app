import type { z } from 'zod';
import { AppError } from '../lib/errors';

/** Parses request data with a shared zod schema or throws a 400 with per-field errors. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Some fields are invalid. Check them and try again.',
      result.error.flatten(),
    );
  }
  return result.data;
}
