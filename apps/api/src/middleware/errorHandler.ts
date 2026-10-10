import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiError } from '@serverdeck/shared';
import { AppError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'This endpoint does not exist'));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    let status = 500;
    let body: ApiError = {
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' },
    };

    const bodyParserType = (err as { type?: string } | null)?.type;
    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details } };
    } else if (bodyParserType === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } };
    } else if (bodyParserType === 'entity.too.large') {
      status = 413;
      body = { error: { code: 'VALIDATION_ERROR', message: 'Request body is too large' } };
    } else {
      logger.error({ err }, 'Unhandled error');
    }

    res.status(status).json(body);
  };
}
