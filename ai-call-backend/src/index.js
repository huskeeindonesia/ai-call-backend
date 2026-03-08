import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const app = buildApp();
app.listen(env.port, () => {
  logger.info({ port: env.port }, 'ai-call-backend listening');
});
