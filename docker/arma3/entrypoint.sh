#!/bin/sh
# Arma 3 dedicated server entrypoint.
#
# Every value used here comes from the panel's own allowlisted environment
# (see container-spec.ts). Nothing is interpolated into a shell string that a
# user can influence - arguments are built as a positional list.

set -eu

SERVER_DIR="/home/steam/server"
GAME_DIR="${SERVER_DIR}/gamefiles"
CONFIG_DIR="${SERVER_DIR}/config"
PROFILE_DIR="${SERVER_DIR}/profiles"
MODS_DIR="${SERVER_DIR}/mods"
BATTLEYE_DIR="${SERVER_DIR}/battleye"

log() {
  printf '[entrypoint] %s\n' "$1"
}

mkdir -p "${GAME_DIR}" "${CONFIG_DIR}" "${PROFILE_DIR}" "${MODS_DIR}" "${BATTLEYE_DIR}"

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

if [ ! -x "${GAME_DIR}/arma3server_x64" ]; then
  log "Arma 3 server files are not present. Downloading with SteamCMD."

  if [ -z "${STEAM_USERNAME:-}" ]; then
    log "ERROR: Arma 3 requires a Steam account that owns the game."
    log "Set STEAM_USERNAME and STEAM_PASSWORD on the panel and reinstall."
    exit 78
  fi

  # Credentials arrive via the environment and are never written to disk or
  # echoed. SteamCMD is invoked with a positional argument list, not a string.
  "${STEAMCMD_DIR}/steamcmd.sh" \
    +force_install_dir "${GAME_DIR}" \
    +login "${STEAM_USERNAME}" "${STEAM_PASSWORD:-}" \
    +app_update "${STEAM_APP_ID}" validate \
    +quit

  if [ ! -x "${GAME_DIR}/arma3server_x64" ]; then
    log "ERROR: SteamCMD finished but the server binary is missing."
    exit 1
  fi

  log "Download complete."
fi

###############################################################################
# Steam client library
#
# The dedicated server dlopen()s steamclient.so from ~/.steam/sdk64 at startup
# and exits if it is not there. SteamCMD ships the library; the server package
# does not, and nothing in the download puts it where the server looks.
###############################################################################

mkdir -p "${HOME}/.steam/sdk32" "${HOME}/.steam/sdk64"
if [ -f "${STEAMCMD_DIR}/linux64/steamclient.so" ]; then
  cp -f "${STEAMCMD_DIR}/linux64/steamclient.so" "${HOME}/.steam/sdk64/steamclient.so"
fi
if [ -f "${STEAMCMD_DIR}/linux32/steamclient.so" ]; then
  cp -f "${STEAMCMD_DIR}/linux32/steamclient.so" "${HOME}/.steam/sdk32/steamclient.so"
fi

###############################################################################
# BattlEye configuration
###############################################################################

if [ -f "${BATTLEYE_DIR}/beserver_x64.cfg" ]; then
  mkdir -p "${GAME_DIR}/battleye"
  cp "${BATTLEYE_DIR}/beserver_x64.cfg" "${GAME_DIR}/battleye/beserver_x64.cfg"
  chmod 0600 "${GAME_DIR}/battleye/beserver_x64.cfg"
fi

###############################################################################
# Mods
###############################################################################

MOD_ARG=""
if [ -f "${CONFIG_DIR}/mods.txt" ]; then
  MOD_LIST="$(cat "${CONFIG_DIR}/mods.txt")"
  if [ -n "${MOD_LIST}" ]; then
    # The panel writes ids as @123456;@789012 and validates each as numeric.
    MOD_ARG="-mod=${MOD_LIST}"
    log "Loading mods: ${MOD_LIST}"
  fi
fi

###############################################################################
# Launch
###############################################################################

cd "${GAME_DIR}"

set -- \
  -config="${CONFIG_DIR}/server.cfg" \
  -cfg="${CONFIG_DIR}/basic.cfg" \
  -profiles="${PROFILE_DIR}" \
  -name=server \
  -port="${ASP_GAME_PORT:-2302}" \
  -world="${ASP_WORLD:-empty}" \
  -autoInit \
  -loadMissionToMemory \
  -limitFPS="${ASP_MAX_FPS:-60}" \
  -noSound \
  -enableHT

if [ -n "${MOD_ARG}" ]; then
  set -- "$@" "${MOD_ARG}"
fi

log "Starting Arma 3 server on port ${ASP_GAME_PORT:-2302} (${ASP_SLOTS:-32} slots)"

# exec so the game process becomes PID 1's direct child and receives SIGTERM.
exec ./arma3server_x64 "$@"
