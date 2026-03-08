import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import healthRoutes from './routes/health.js';
import callRoutes from './routes/calls.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';

export function buildApp() {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, genReqId: () => crypto.randomUUID() }));

  app.use(healthRoutes);
  app.use(authMiddleware);
  app.use(callRoutes);

  app.use(errorHandler);
  return app;
}
