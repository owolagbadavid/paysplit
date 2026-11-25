import * as Sentry from '@sentry/node';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createContext } from './create-context.ts';
import { startWorker } from './modules/scheduler.ts';

const config = loadConfig();
if (config.SENTRY_DSN) Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV });

const { ctx, close } = createContext(config);
const app = await buildApp(ctx);
const stopWorker = config.WORKER ? startWorker(ctx) : async () => {};
await app.listen({ port: config.PORT, host: '0.0.0.0' });
if (config.emulated)
  ctx.log.warn('Using local provider emulators. Nothing reaches the payment provider or Dojah.');

const shutdown = async (signal: string) => {
  ctx.log.info({ signal }, 'shutting down');
  await app.close();
  await stopWorker();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
