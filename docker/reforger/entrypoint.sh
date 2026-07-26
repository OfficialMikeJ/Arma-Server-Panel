#!/bin/sh
# Arma Reforger dedicated server entrypoint.

set -eu

SERVER_DIR="/home/steam/server"
GAME_DIR="${SERVER_DIR}/gamefiles"
CONFIG_DIR="${SERVER_DIR}/config"
PROFILE_DIR="${SERVER_DIR}/profiles"
WORKSHOP_DIR="${SERVER_DIR}/workshop"

log() {
  printf '[entrypoint] %s\n' "$1"
}

mkdir -p "${GAME_DIR}" "${CONFIG_DIR}" "${PROFILE_DIR}" "${WORKSHOP_DIR}"

###############################################################################
# Install / update game files
###############################################################################

if [ ! -x "${GAME_DIR}/ArmaReforgerServer" ]; then
  log "Reforger server files are not present. Downloading with SteamCMD."

  # Anonymous login: the Reforger server package is free.
  /opt/steamcmd/steamcmd.sh \
    +force_install_dir "${GAME_DIR}" \
    +login anonymous \
    +app_update "${STEAM_APP_ID}" validate \
    +quit

  if [ ! -x "${GAME_DIR}/ArmaReforgerServer" ]; then
    log "ERROR: SteamCMD finished but the server binary is missing."
    exit 1
  fi

  log "Download complete."
fi

###############################################################################
# Configuration
###############################################################################

CONFIG_FILE="${CONFIG_DIR}/config.json"

if [ ! -f "${CONFIG_FILE}" ]; then
  log "ERROR: ${CONFIG_FILE} was not written by the panel."
  exit 78
fi

###############################################################################
# Launch
###############################################################################

cd "${GAME_DIR}"

set -- \
  -config "${CONFIG_FILE}" \
  -profile "${PROFILE_DIR}" \
  -addonsDir "${WORKSHOP_DIR}" \
  -maxFPS "${ASP_MAX_FPS:-60}" \
  -logStats 60000 \
  -bindPort "${ASP_GAME_PORT:-2001}" \
  -a2sQueryEnabled \
  -nds "${ASP_NDS:-3}" \
  -listScenarios

# Reforger downloads its own workshop content on start; the panel supplies the
# mod list inside config.json.
if [ -n "${ASP_LOAD_SESSION_SAVE:-}" ]; then
  set -- "$@" -loadSessionSave "${ASP_LOAD_SESSION_SAVE}"
fi

log "Starting Arma Reforger server on port ${ASP_GAME_PORT:-2001} (${ASP_SLOTS:-64} slots)"

exec ./ArmaReforgerServer "$@"
