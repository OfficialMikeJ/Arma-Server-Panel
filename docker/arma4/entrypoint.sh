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

###############################################################################
# Writable locations for SteamCMD
#
# The root filesystem is read-only by design and the data volume is the only
# writable path. SteamCMD needs to write in two places that are not on it:
#
#   * its own installation directory, which it self-updates on every run
#   * $HOME, where it keeps ~/.steam
#
# /opt/steamcmd and /home/steam are both on the read-only root, so without this
# the download fails immediately and the container exits 1 - which is what a
# "server crashed" with no game files actually was.
#
# Staged onto the volume once; the copy survives restarts and reinstalls.
###############################################################################

export HOME="${SERVER_DIR}/.home"
STEAMCMD_DIR="${SERVER_DIR}/.steamcmd"
mkdir -p "${HOME}" "${STEAMCMD_DIR}"

if [ ! -x "${STEAMCMD_DIR}/steamcmd.sh" ]; then
  log "Staging SteamCMD onto the data volume (the root filesystem is read-only)."
  cp -a /opt/steamcmd/. "${STEAMCMD_DIR}/"
fi


if [ -z "${STEAM_APP_ID:-}" ]; then
  log "Arma 4 has not been released, so there is no server package to install."
  log "When it launches: set STEAM_APP_ID on this image, flip released to true"
  log "in packages/shared/src/games.ts, and rebuild. Nothing else changes."
  exit 78
fi

if [ ! -x "${GAME_DIR}/${SERVER_BINARY}" ]; then
  log "Downloading Arma 4 server files with SteamCMD."
  "${STEAMCMD_DIR}/steamcmd.sh" \
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
