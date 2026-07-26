# Arma Server Panel API
#
# Multi-stage so the runtime image carries no compiler, no source and no dev
# dependencies. Runs as a non-root user.

FROM node:22-bookworm-slim AS deps

WORKDIR /build

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN npm ci --workspace @asp/shared --workspace @asp/api --include-workspace-root


FROM node:22-bookworm-slim AS build

# Prisma detects the OpenSSL version from this binary when choosing which query
# engine to emit. Without it, it guesses wrong and the engine fails to load at
# runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY tsconfig.base.json package.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN npm run build -w @asp/shared \
 && npx --workspace @asp/api prisma generate \
 && npm run build -w @asp/api


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

# openssl is required by Prisma's query engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages/shared/dist ./packages/shared/dist
COPY --from=build /build/packages/shared/package.json ./packages/shared/
COPY --from=build /build/apps/api/dist ./apps/api/dist
COPY --from=build /build/apps/api/package.json ./apps/api/
COPY --from=build /build/apps/api/prisma ./apps/api/prisma

COPY docker/api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh

# The volume root must be writable by this user; compose mounts it in.
RUN mkdir -p /var/lib/arma-server-panel/servers \
 && chown -R node:node /var/lib/arma-server-panel /app

USER node
WORKDIR /app/apps/api

EXPOSE 4000

# Migrations are applied and the bootstrap admin seeded before the server
# starts, so a fresh deployment needs no manual database step.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
