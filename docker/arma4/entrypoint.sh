#!/bin/sh
# Arma 4 dedicated server entrypoint - placeholder.
#
# Fails loudly rather than silently doing nothing, so a misconfiguration is
# obvious in the panel console instead of looking like a mysterious crash.

set -eu

SERVER_DIR="/home/steam/server"
GAME_DIR="${SERVER_DIR}/gamefiles"
CONFIG_DIR="${SERVER_DIR}/config"
PROFILE_DIR="${SERVER_DIR}/profiles"

log() {
  printf '[entrypoint] %s\n' "$1"
}

mkdir -p "${GAME_DIR}" "${CONFIG_DIR}" "${PROFILE_DIR}"

if [ -z "${STEAM_APP_ID:-}" ]; then
  log "Arma 4 has not been released, so there is no server package to install."
  log "When it launches: set STEAM_APP_ID on this image, flip released to true"
  log "in packages/shared/src/games.ts, and rebuild. Nothing else changes."
  exit 78
fi

if [ ! -x "${GAME_DIR}/${SERVER_BINARY}" ]; then
  log "Downloading Arma 4 server files with SteamCMD."
  /opt/steamcmd/steamcmd.sh \
    +force_install_dir "${GAME_DIR}" \
    +login anonymous \
    +app_update "${STEAM_APP_ID}" validate \
    +quit
fi

if [ ! -x "${GAME_DIR}/${SERVER_BINARY}" ]; then
  log "ERROR: server binary ${SERVER_BINARY} not found after install."
  exit 1
fi

cd "${GAME_DIR}"

set -- \
  -config "${CONFIG_DIR}/config.json" \
  -profile "${PROFILE_DIR}" \
  -maxFPS "${ASP_MAX_FPS:-60}" \
  -bindPort "${ASP_GAME_PORT:-2001}"

log "Starting Arma 4 server on port ${ASP_GAME_PORT:-2001}"

exec "./${SERVER_BINARY}" "$@"
