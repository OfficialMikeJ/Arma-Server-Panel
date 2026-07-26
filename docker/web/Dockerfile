# Arma Server Panel web app
#
# Uses Next.js standalone output, so the runtime image contains only the server
# bundle and the static assets - no node_modules, no source.

FROM node:22-bookworm-slim AS deps

WORKDIR /build

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN npm ci --workspace @asp/shared --workspace @asp/web --include-workspace-root


FROM node:22-bookworm-slim AS build

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
# The lockfile matters here: Next uses it to locate the workspace root when
# tracing files for the standalone bundle.
COPY tsconfig.base.json package.json package-lock.json* ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Guarantee the static asset directory exists, so the runtime COPY below has a
# source even on a checkout that carries no public files yet.
RUN mkdir -p apps/web/public \
 && npm run build -w @asp/shared \
 && npm run build -w @asp/web


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Next's standalone server uses HOSTNAME as its bind address. Docker otherwise
# sets it to the container id, so the server listens on a single interface and
# forwarded connections are reset by peer.
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /build/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /build/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /build/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "apps/web/server.js"]
