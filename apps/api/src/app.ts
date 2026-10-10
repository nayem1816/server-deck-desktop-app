import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { meRouter } from './routes/me';
import { serversRouter, syncRouter } from './routes/sync';
import { createSyncService } from './services/sync';

export function createApp(ctx: AppContext): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.TRUST_PROXY);
  app.use(helmet());
  // The desktop app calls the API from the Electron main process, so CORS only matters
  // for browser-based development (D-016).
  app.use(cors({ origin: ctx.config.CORS_ORIGINS.length > 0 ? ctx.config.CORS_ORIGINS : false }));
  app.use(
    pinoHttp({
      logger: ctx.logger,
      quietReqLogger: true,
      // Method, path and status only: headers and bodies can carry tokens.
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp });
  });

  app.use('/auth', authRouter(ctx));
  app.use('/me', meRouter(ctx));
  const sync = createSyncService();
  app.use('/sync', syncRouter(ctx, sync));
  app.use('/servers', serversRouter(ctx, sync));

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.logger));
  return app;
}
