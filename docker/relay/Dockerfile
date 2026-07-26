# Arma Server Panel - relay daemon
#
# Deploy this on a host with a PUBLIC IP address. It cannot do its job from
# behind the same NAT as the panel: its entire purpose is to be the public
# endpoint players connect to.

FROM node:22-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json* ./
COPY services/relay/package.json services/relay/

RUN npm ci --workspace @asp/relay --include-workspace-root

COPY tsconfig.base.json ./
COPY services/relay ./services/relay

RUN npm run build -w @asp/relay


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The daemon has no runtime dependencies - it is Node built-ins only - so the
# runtime image carries the compiled output and nothing else.
COPY --from=build --chown=node:node /build/services/relay/dist ./dist

USER node

# Control plane (HTTP, put TLS in front) and the data plane (UDP).
EXPOSE 8080/tcp 9000/udp

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/relay.js"]
