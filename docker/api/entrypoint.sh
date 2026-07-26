#!/bin/sh
# API container entrypoint.
#
# Applies pending database migrations, then starts the server. The bootstrap
# administrator is created by the server itself on startup (see
# modules/platform/bootstrap.ts) rather than by a seed script here, so that a
# failure surfaces as a startup error instead of being swallowed by the shell.

set -eu

log() {
  printf '[entrypoint] %s\n' "$1"
}

log "Applying database migrations..."
if ! npx prisma migrate deploy; then
  log "ERROR: migrations failed. The server will not start."
  log "If this is a fresh install with a half-applied migration, wipe the"
  log "database volume and try again:  docker compose down -v && docker compose up -d"
  exit 1
fi

log "Starting API..."
exec node dist/server.js
