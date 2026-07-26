import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma, disconnectDb } from './db/client.js';
import { startScheduler, stopScheduler } from './modules/scheduler/scheduler.js';
import { ensurePlatformSettings } from './modules/platform/platform-settings.js';
import { ensureBootstrapAdmin } from './modules/platform/bootstrap.js';
import { serverSupervisor } from './modules/servers/supervisor.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Fail fast if the database is unreachable rather than serving 500s.
  await prisma.$queryRaw`SELECT 1`;
  await ensurePlatformSettings();
  // Creates the administrator on a fresh database, and does nothing once one
  // exists. A failure here is fatal by design - a panel nobody can log into is
  // worse than one that refuses to start.
  await ensureBootstrapAdmin();

  const app = await buildApp();

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info(
    { host: config.API_HOST, port: config.API_PORT, env: config.NODE_ENV },
    'Arma Server Panel API listening',
  );

  await serverSupervisor.start();
  startScheduler();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 20_000);
    timer.unref();

    try {
      stopScheduler();
      await serverSupervisor.stop();
      await app.close();
      await disconnectDb();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // exit so the supervisor restarts us cleanly rather than limping on.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start');
  process.exit(1);
});
