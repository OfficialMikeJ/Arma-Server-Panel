/**
 * Response security headers.
 *
 * The API serves JSON only, so its CSP is the most restrictive one possible
 * (`default-src 'none'`). The web app sets its own, stricter-per-page CSP with
 * nonces - see apps/web/middleware.ts.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config/env.js';

const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox",
].join('; ');

export default fp(async function securityHeaders(app: FastifyInstance) {
  const config = loadConfig();

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy', API_CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('cross-origin-embedder-policy', 'require-corp');
    reply.header('origin-agent-cluster', '?1');
    reply.header(
      'permissions-policy',
      [
        'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()',
        'encrypted-media=()', 'fullscreen=(self)', 'geolocation=()', 'gyroscope=()',
        'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
        'picture-in-picture=()', 'publickey-credentials-get=(self)',
        'screen-wake-lock=()', 'usb=()', 'xr-spatial-tracking=()',
      ].join(', '),
    );

    // Authenticated API responses must never be cached by an intermediary.
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
      reply.header('pragma', 'no-cache');
    }

    if (config.isProduction) {
      reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
    }

    // Fastify does not advertise itself, but be explicit.
    reply.removeHeader('x-powered-by');
    reply.removeHeader('server');

    return payload;
  });
});
