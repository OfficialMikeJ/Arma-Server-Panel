import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output so the production image can drop node_modules.
  output: 'standalone',
  // Pinned explicitly. Next infers this from the nearest lockfile, which
  // differs between a local build and the Docker build stage - and the guess
  // decides whether server.js lands at standalone/server.js or
  // standalone/apps/web/server.js. Pinning it keeps the path stable.
  outputFileTracingRoot: path.join(here, '..', '..'),
  transpilePackages: ['@asp/shared'],

  experimental: {
    // Server Actions are not used; disabling narrows the attack surface.
    serverActions: { allowedOrigins: [] },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
        ],
      },
      {
        // The panel is authenticated; never let an intermediary cache it.
        source: '/panel/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
