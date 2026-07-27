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


###############################################################################
# Install / update game files
###############################################################################

if [ ! -x "${GAME_DIR}/ArmaReforgerServer" ]; then
  log "Reforger server files are not present. Downloading with SteamCMD."

  # Anonymous login: the Reforger server package is free.
  "${STEAMCMD_DIR}/steamcmd.sh" \
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
  -nds "${ASP_NDS:-3}" \
  -listScenarios

# A2S is a startup flag, not a config field. It was passed unconditionally, so
# the panel's "Answer A2S queries" setting did nothing either way.
if [ "${ASP_A2S_ENABLED:-1}" = "1" ]; then
  set -- "$@" -a2sQueryEnabled
fi

# Also a startup parameter rather than a config field.
if [ -n "${ASP_AUTO_RELOAD:-}" ]; then
  set -- "$@" -autoReload "${ASP_AUTO_RELOAD}"
fi

# Reforger downloads its own workshop content on start; the panel supplies the
# mod list inside config.json.
if [ -n "${ASP_LOAD_SESSION_SAVE:-}" ]; then
  set -- "$@" -loadSessionSave "${ASP_LOAD_SESSION_SAVE}"
fi

log "Starting Arma Reforger server on port ${ASP_GAME_PORT:-2001} (${ASP_SLOTS:-64} slots)"

exec ./ArmaReforgerServer "$@"
