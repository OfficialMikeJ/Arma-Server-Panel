import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { checkDockerHealth } from '../modules/docker/docker-client.js';
import { getPlatformSettings } from '../modules/platform/platform-settings.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness. Must stay trivial - it is polled by the process supervisor. */
  app.get('/health', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok', at: new Date().toISOString() }),
  );

  /**
   * Readiness. Deliberately unauthenticated but deliberately vague: it reports
   * whether dependencies are up, never version strings or error details that
   * would help someone fingerprint the deployment.
   */
  app.get('/health/ready', async (_request, reply) => {
    const [dbOk, docker, settings] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      checkDockerHealth().catch(() => ({ available: false }) as { available: boolean }),
      getPlatformSettings().catch(() => null),
    ]);

    const ready = dbOk && docker.available;

    return reply.status(ready ? 200 : 503).header('cache-control', 'no-store').send({
      status: ready ? 'ready' : 'degraded',
      database: dbOk,
      containerRuntime: docker.available,
      setupComplete: settings?.setupComplete ?? false,
    });
  });
}
