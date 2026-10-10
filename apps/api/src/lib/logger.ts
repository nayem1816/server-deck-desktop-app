import pino from 'pino';
import type { Config } from '../config';

/** Paths that must never reach the logs (tokens, keys, secrets). */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authKey',
  '*.currentAuthKey',
  '*.newAuthKey',
  '*.refreshToken',
  '*.accessToken',
  '*.resetToken',
  '*.code',
  '*.secretEnc',
  '*.passphraseEnc',
];

export function createLogger(config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>) {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: { paths: REDACT, censor: '[redacted]' },
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
