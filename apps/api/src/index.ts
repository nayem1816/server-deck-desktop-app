import { createApp } from './app';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { connectDatabase, disconnectDatabase } from './db';
import { createLogger } from './lib/logger';
import { createMailer } from './lib/mailer';
import { createSyncService } from './services/sync';
import { createTokenService } from './services/tokens';

const PURGE_INTERVAL_MS = 6 * 3600 * 1000;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const ctx: AppContext = {
    config,
    logger,
    mailer: createMailer(config, logger),
    tokens: createTokenService(config),
  };

  await connectDatabase(config.MONGODB_URI);
  logger.info('Connected to MongoDB');

  const server = createApp(ctx).listen(config.PORT, () => {
    logger.info(`ServerDeck API listening on http://localhost:${config.PORT}`);
  });

  // Trash older than 30 days is purged a few times a day (D-015).
  const sync = createSyncService();
  const purge = () =>
    sync
      .purgeTrash()
      .then((n) => n > 0 && logger.info(`Purged ${n} servers from trash`))
      .catch((err: unknown) => logger.error({ err }, 'Trash purge failed'));
  void purge();
  const purgeTimer = setInterval(() => void purge(), PURGE_INTERVAL_MS);

  const shutdown = (signal: string) => {
    clearInterval(purgeTimer);
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      void disconnectDatabase().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
