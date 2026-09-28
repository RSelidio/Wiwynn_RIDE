/**
 * Process entry point.
 *
 * Starts the HTTP server, attaches Socket.IO to the same listener (so one port
 * serves both, which is what lets IIS proxy a single site) and then the
 * background jobs. Shuts down in the reverse order on a signal.
 */

import { createServer } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { assertDatabaseReachable, closePool } from './db/pool';
import { startScheduler, stopScheduler } from './jobs/scheduler';
import { logger } from './logger';
import { closeSocketServer, createSocketServer } from './realtime/io';

async function main(): Promise<void> {
  // Fail fast on an unreachable database rather than serving 500s.
  await assertDatabaseReachable();

  const app = createApp();
  const httpServer = createServer(app);

  createSocketServer(httpServer);
  await startScheduler();

  await new Promise<void>((resolve) => {
    httpServer.listen(config.http.port, config.http.host, resolve);
  });

  logger.info(
    {
      url: `http://${config.http.host}:${config.http.port}`,
      env: config.env,
      cors: config.http.corsOrigins,
      sso: config.auth.ssoConfigured ? 'entra configured' : 'local only',
    },
    'shuttle backend listening',
  );

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    // A second Ctrl-C should not start a parallel shutdown.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');

    // Stop taking new work, then let in-flight requests finish.
    stopScheduler();

    const forceExit = setTimeout(() => {
      logger.warn('shutdown timed out — exiting anyway');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    void (async () => {
      try {
        await closeSocketServer();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await closePool();
        clearTimeout(forceExit);
        logger.info('shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // On Windows, PM2 and the service wrapper signal shutdown this way.
  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('message');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    // The process state is no longer trustworthy; log and let the supervisor
    // restart us rather than limping on.
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
