import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { FILE_MANAGER } from '@asp/shared';

import { loadConfig } from './config/env.js';
import { logger } from './lib/logger.js';
import securityHeaders from './plugins/security-headers.js';
import errorHandler from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import globalRateLimit from './plugins/global-rate-limit.js';

import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerModRoutes } from './routes/mods.js';
import { registerFileRoutes } from './routes/files.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerPublicRoutes } from './routes/public.js';

export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    // Pino's concrete Logger type is narrower than FastifyBaseLogger; the
    // instance satisfies the interface at runtime.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // We derive the client address ourselves - see security/client-identity.ts.
    // Fastify's own trustProxy is left off so the two cannot disagree.
    trustProxy: false,
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    // Reject requests whose Content-Type we do not explicitly handle.
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    caseSensitive: true,
    requestIdHeader: false,
    maxParamLength: 128,
    connectionTimeout: 30_000,
    keepAliveTimeout: 30_000,
  });

  await app.register(securityHeaders);
  await app.register(errorHandler);

  await app.register(cookie, {
    // Cookies are opaque high-entropy tokens; signing adds nothing and would
    // introduce another key to manage.
    parseOptions: { path: '/', sameSite: 'strict', httpOnly: true },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser requests have no Origin header.
      if (!origin) return callback(null, true);
      callback(null, origin === config.appOrigin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'x-asp-csrf', 'x-api-key'],
    exposedHeaders: ['retry-after'],
    maxAge: 600,
  });

  await app.register(multipart, {
    limits: {
      fileSize: FILE_MANAGER.maxUploadBytes,
      files: 1,
      fields: 10,
      headerPairs: 100,
    },
  });

  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      // Verified per-connection in the console route.
      clientTracking: true,
    },
  });

  await app.register(globalRateLimit);
  await app.register(authPlugin);

  await app.register(
    async (api) => {
      await registerHealthRoutes(api);
      await registerPublicRoutes(api);
      await registerSetupRoutes(api);
      await registerAuthRoutes(api);
      await registerAdminAuthRoutes(api);
      await registerAccountRoutes(api);
      await registerNodeRoutes(api);
      await registerServerRoutes(api);
      await registerConsoleRoutes(api);
      await registerModRoutes(api);
      await registerFileRoutes(api);
      await registerNetworkRoutes(api);
      await registerIntegrationRoutes(api);
      await registerApiKeyRoutes(api);
      await registerMetricRoutes(api);
      await registerAiRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
