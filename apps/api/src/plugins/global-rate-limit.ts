/**
 * Coarse per-client request ceiling.
 *
 * Route-specific limits (login, registration, reinstall) are far tighter and
 * live next to their routes. This one exists purely to stop a single client
 * saturating the process.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { RATE_LIMITS } from '@asp/shared';
import { buildKey, consumeRateLimit } from '../security/rate-limit.js';
import { getClientIdentity } from '../security/client-identity.js';
import { tooManyRequests } from '../lib/errors.js';

/** Paths exempt from the global ceiling - they must stay reachable under load. */
const EXEMPT = new Set(['/api/v1/health', '/api/v1/health/ready']);

export default fp(async function globalRateLimit(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (EXEMPT.has(request.url.split('?')[0] ?? '')) return;

    // Long-lived console sockets are counted once at upgrade, not per frame.
    const identity = getClientIdentity(request);
    const result = await consumeRateLimit(
      buildKey('global', identity.ipHash.slice(0, 32)),
      RATE_LIMITS.global,
    );

    reply.header('x-ratelimit-limit', String(result.limit));
    reply.header('x-ratelimit-remaining', String(result.remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(result.resetMs / 1000)));

    if (!result.allowed) {
      throw tooManyRequests('Too many requests. Slow down.', result.resetMs / 1000);
    }
  });
});
