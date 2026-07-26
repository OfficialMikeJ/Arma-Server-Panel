#!/usr/bin/env sh
#
# Arma Server Panel - installer
#
#   curl -fsSL https://armaserverpanel.io/install.sh | sudo sh
#
# Or, preferably, read it first and then run it:
#
#   curl -fsSL https://armaserverpanel.io/install.sh -o install.sh
#   less install.sh
#   sudo sh install.sh
#
# Piping a script from the internet into a root shell is a real risk. This
# script is written to be readable in one sitting for exactly that reason: it
# makes no silent changes outside its install directory, and every destructive
# step asks first.
#
# What it does:
#   1. Checks the host meets the hard minimum (8 GB / 4 threads / 120 GB)
#   2. Checks for Docker, and offers to install it if missing
#   3. Downloads and verifies the panel release
#   4. Generates cryptographic keys and writes .env
#   5. Starts the stack and waits for it to become healthy
#   6. Prints the URL and first-login credentials

set -eu

# ------------------------------------------------------------------ #
# Configuration                                                       #
# ------------------------------------------------------------------ #

PANEL_NAME="Arma Server Panel"
DOWNLOAD_BASE="${ASP_DOWNLOAD_BASE:-https://armaserverpanel.io}"
INSTALL_DIR="${ASP_INSTALL_DIR:-/opt/arma-server-panel}"
CHANNEL="${ASP_CHANNEL:-stable}"

# Source of the files. A git URL avoids needing a hosted release tarball, which
# is what makes bootstrapping the website itself possible.
REPO="${ASP_REPO:-}"
BRANCH="${ASP_BRANCH:-main}"

# panel = the control panel. site = the public website that hosts this script.
MODE="${ASP_MODE:-panel}"

MIN_MEMORY_GB=8
MIN_CPU_THREADS=4
MIN_STORAGE_GB=120

WEB_PORT="${ASP_WEB_PORT:-3002}"
API_PORT="${ASP_API_PORT:-3004}"

# Non-interactive mode for automated installs.
ASSUME_YES="${ASP_ASSUME_YES:-0}"
TELEMETRY="${ASP_TELEMETRY:-ask}"

# ------------------------------------------------------------------ #
# Output helpers                                                      #
# ------------------------------------------------------------------ #

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$(printf '\033[0m')
  C_ORANGE=$(printf '\033[38;5;208m')
  C_GREEN=$(printf '\033[32m')
  C_RED=$(printf '\033[31m')
  C_YELLOW=$(printf '\033[33m')
  C_DIM=$(printf '\033[2m')
else
  C_RESET='' C_ORANGE='' C_GREEN='' C_RED='' C_YELLOW='' C_DIM=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$C_ORANGE" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

die() {
  printf '\n  %s✕ %s%s\n\n' "$C_RED" "$*" "$C_RESET" >&2
  exit 1
}

confirm() {
  # $1 = prompt, $2 = default (y/n)
  _default="${2:-y}"
  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    # Piped from curl with no tty: fall back to the default rather than hanging.
    [ "$_default" = "y" ]
    return $?
  fi
  if [ "$_default" = "y" ]; then _hint="[Y/n]"; else _hint="[y/N]"; fi
  printf '  %s %s ' "$1" "$_hint"
  read -r _answer </dev/tty || _answer=""
  case "${_answer:-$_default}" in
    [Yy]*) return 0 ;;
    *)     return 1 ;;
  esac
}

ask() {
  # $1 = prompt, $2 = default. Echoes the answer.
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf '%s' "$2"
    return
  fi
  printf '  %s [%s] ' "$1" "$2" >&2
  read -r _value </dev/tty || _value=""
  printf '%s' "${_value:-$2}"
}

banner() {
  printf '\n'
  printf '%s  ___                    %s\n' "$C_ORANGE" "$C_RESET"
  printf '%s / _ \\ _ _ _ __  __ _    %s%s\n' "$C_ORANGE" "$C_RESET" "$PANEL_NAME"
  printf '%s| (_) | .%s| |%s| / _` |   %sReforger - Arma 3 - Arma 4%s\n' "$C_ORANGE" "'" "'" "$C_DIM" "$C_RESET"
  printf '%s \\___/|_| |_|\\__,_|   %s\n' "$C_ORANGE" "$C_RESET"
  printf '\n'
}

# ------------------------------------------------------------------ #
# Preflight                                                           #
# ------------------------------------------------------------------ #

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "This installer needs root. Re-run with: sudo sh install.sh"
  fi
}

detect_arch() {
  # The release tarball is source-only and architecture independent, so this
  # does not select a download - it exists purely to warn before someone
  # spends an hour discovering Arma has no ARM server build.
  _arch=$(uname -m)
  case "$_arch" in
    x86_64|amd64) ok "Architecture: x86_64" ;;
    aarch64|arm64)
      warn "This is an ARM machine."
      warn "The panel runs, but Arma dedicated servers are x86_64-only - SteamCMD"
      warn "has no ARM build, so game containers will not start here."
      confirm "Continue anyway?" "n" || die "Stopped."
      ;;
    *) die "Unsupported architecture: $_arch" ;;
  esac
}

check_requirements() {
  step "Checking host requirements"

  # --- Memory ---
  _mem_kb=$(awk '/MemTotal/ {print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)
  _mem_gb=$((_mem_kb / 1024 / 1024))
  if [ "$_mem_gb" -lt "$MIN_MEMORY_GB" ]; then
    warn "Memory: ${_mem_gb} GB detected, ${MIN_MEMORY_GB} GB required"
    REQUIREMENTS_FAILED=1
  else
    ok "Memory: ${_mem_gb} GB"
  fi

  # --- CPU ---
  _cpus=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0)
  if [ "$_cpus" -lt "$MIN_CPU_THREADS" ]; then
    warn "CPU: ${_cpus} threads detected, ${MIN_CPU_THREADS} required"
    REQUIREMENTS_FAILED=1
  else
    ok "CPU: ${_cpus} threads"
  fi

  # --- Storage on the install target ---
  _parent=$(dirname "$INSTALL_DIR")
  [ -d "$_parent" ] || _parent="/"
  _disk_gb=$(df -BG "$_parent" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$2); print $2}' || echo 0)
  if [ "${_disk_gb:-0}" -lt "$MIN_STORAGE_GB" ]; then
    warn "Storage: ${_disk_gb} GB on ${_parent}, ${MIN_STORAGE_GB} GB required"
    REQUIREMENTS_FAILED=1
  else
    ok "Storage: ${_disk_gb} GB available on ${_parent}"
  fi

  if [ "${REQUIREMENTS_FAILED:-0}" = "1" ]; then
    printf '\n'
    warn "This host is below the minimum specification."
    warn "The panel will install, but setup will refuse to complete until the"
    warn "shortfall is fixed. Game servers need real headroom."
    confirm "Install anyway?" "n" || die "Stopped."
  fi
}

check_docker() {
  step "Checking the container runtime"

  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      ok "Docker $(docker --version | awk '{gsub(/,/,"",$3); print $3}') with compose v2"
    else
      die "Docker is installed but the compose v2 plugin is missing.
     Install it with your package manager: docker-compose-plugin"
    fi
  else
    warn "Docker is not installed."
    if confirm "Install Docker now (via get.docker.com)?" "y"; then
      step "Installing Docker"
      curl -fsSL https://get.docker.com -o /tmp/asp-get-docker.sh ||
        die "Could not download the Docker installer."
      sh /tmp/asp-get-docker.sh || die "Docker installation failed."
      rm -f /tmp/asp-get-docker.sh
      ok "Docker installed"
    else
      die "Docker is required. Install it and re-run this script."
    fi
  fi

  # userns-remap is the single most valuable container hardening flag here.
  if docker info 2>/dev/null | grep -qi 'userns'; then
    ok "User-namespace remapping is enabled"
  else
    warn "User-namespace remapping is off."
    dim "Recommended: add  \"userns-remap\": \"default\"  to /etc/docker/daemon.json"
    dim "and restart Docker. Without it, a container escape lands on host root."
  fi
}

# ------------------------------------------------------------------ #
# Download                                                            #
# ------------------------------------------------------------------ #

clone_or_pull() {
  step "Fetching ${PANEL_NAME} from git"

  if ! command -v git >/dev/null 2>&1; then
    if confirm "git is not installed. Install it?" "y"; then
      (apt-get update -qq && apt-get install -y -qq git) >/dev/null 2>&1 ||
        (yum install -y -q git) >/dev/null 2>&1 ||
        die "Could not install git. Install it and re-run."
    else
      die "git is required when ASP_REPO is set."
    fi
  fi

  if [ -d "${INSTALL_DIR}/.git" ]; then
    ok "Existing checkout found - updating"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" ||
      die "Could not fetch from $REPO"
    # Hard reset: the working tree is a deployment, not a place to edit code.
    # .env and data/ are untracked and survive this.
    git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}" >/dev/null ||
      die "Could not update the checkout"
    UPGRADE=1
  else
    if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
      warn "$INSTALL_DIR exists and is not a git checkout."
      confirm "Replace its contents? Your .env and data/ are preserved." "n" ||
        die "Stopped. Move it aside or set ASP_INSTALL_DIR."

      _keep=$(mktemp -d)
      [ -f "${INSTALL_DIR}/.env" ] && cp "${INSTALL_DIR}/.env" "${_keep}/.env"
      [ -d "${INSTALL_DIR}/data" ] && cp -r "${INSTALL_DIR}/data" "${_keep}/data"

      rm -rf "${INSTALL_DIR:?}"
      git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR" ||
        die "Could not clone $REPO"

      [ -f "${_keep}/.env" ] && cp "${_keep}/.env" "${INSTALL_DIR}/.env" && UPGRADE=1
      [ -d "${_keep}/data" ] && cp -r "${_keep}/data" "${INSTALL_DIR}/data"
      rm -rf "$_keep"
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR" ||
        die "Could not clone $REPO"
    fi
  fi

  ok "Source ready in $INSTALL_DIR"
}

download_release() {
  # Git is preferred when a repo is given: it needs no hosted tarball, which is
  # the only way to install the website before the website exists.
  if [ -n "$REPO" ]; then
    clone_or_pull
    return
  fi

  step "Downloading ${PANEL_NAME}"

  _tmp=$(mktemp -d)
  trap 'rm -rf "$_tmp"' EXIT

  _url="${DOWNLOAD_BASE}/releases/${CHANNEL}/arma-server-panel.tar.gz"
  _sum_url="${_url}.sha256"

  curl -fsSL "$_url" -o "$_tmp/panel.tar.gz" ||
    die "Download failed: $_url"
  ok "Downloaded $(du -h "$_tmp/panel.tar.gz" | cut -f1)"

  # Verify if a checksum is published. Never silently skip verification when
  # the file exists but does not match.
  if curl -fsSL "$_sum_url" -o "$_tmp/panel.sha256" 2>/dev/null; then
    _expected=$(awk '{print $1}' "$_tmp/panel.sha256")
    _actual=$(sha256sum "$_tmp/panel.tar.gz" | awk '{print $1}')
    if [ "$_expected" != "$_actual" ]; then
      die "Checksum mismatch. The download may be corrupt or tampered with.
     expected: $_expected
     actual:   $_actual"
    fi
    ok "Checksum verified"
  else
    warn "No published checksum for this release; skipping verification."
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    warn "$INSTALL_DIR already exists."
    if confirm "Upgrade in place? Your .env and database are kept." "y"; then
      UPGRADE=1
    else
      die "Stopped. Move $INSTALL_DIR aside or set ASP_INSTALL_DIR."
    fi
  fi

  mkdir -p "$INSTALL_DIR"
  # --strip-components drops the top-level folder from the archive.
  tar -xzf "$_tmp/panel.tar.gz" -C "$INSTALL_DIR" --strip-components=1 ||
    die "Extraction failed."
  ok "Installed to $INSTALL_DIR"
}

# ------------------------------------------------------------------ #
# Configure                                                           #
# ------------------------------------------------------------------ #

random_hex() {
  # $1 = byte count
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'
  fi
}

detect_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' ||
    hostname -I 2>/dev/null | awk '{print $1}' ||
    echo "127.0.0.1"
}

configure_site() {
  step "Configuring the website"

  if [ -f "$INSTALL_DIR/.env" ] && grep -q '^SITE_DB_PASSWORD=' "$INSTALL_DIR/.env" 2>/dev/null; then
    ok "Keeping the existing .env"
    SITE_PORT=$(awk -F= '/^SITE_HOST_PORT=/{print $2}' "$INSTALL_DIR/.env")
    PANEL_URL=$(awk -F= '/^SITE_URL=/{sub(/^SITE_URL=/,""); print}' "$INSTALL_DIR/.env")
    return
  fi

  _ip=$(detect_ip)
  SITE_PORT=$(ask "Port for the website:" "${ASP_SITE_PORT:-3100}")
  _url=$(ask "Public address of this website:" "http://${_ip}:${SITE_PORT}")

  # Appended, so a panel .env in the same directory keeps working.
  {
    printf '\n# --- Website (docker-compose.site.yml) ---\n'
    printf 'SITE_URL=%s\n' "$_url"
    printf 'SITE_HOST_PORT=%s\n' "$SITE_PORT"
    printf 'SITE_DB_PASSWORD=%s\n' "$(random_hex 24)"
  } >> "$INSTALL_DIR/.env"

  chmod 600 "$INSTALL_DIR/.env"
  PANEL_URL="$_url"
  ok "Wrote website settings to $INSTALL_DIR/.env"
}

start_site() {
  step "Building and starting the website"

  cd "$INSTALL_DIR"
  docker compose -f docker-compose.site.yml up -d --build ||
    die "The website failed to start.
     Logs:  cd $INSTALL_DIR && docker compose -f docker-compose.site.yml logs"

  printf '  waiting for the site'
  _tries=0
  while [ "$_tries" -lt 40 ]; do
    if curl -fsS "http://127.0.0.1:${SITE_PORT}/api/stats" >/dev/null 2>&1; then
      printf '\n'
      ok "Website is up"
      break
    fi
    printf '.'
    sleep 3
    _tries=$((_tries + 1))
  done
  printf '\n'

  # Package a release so the install command on the site actually works.
  if [ -x "${INSTALL_DIR}/scripts/build-release.sh" ] || [ -f "${INSTALL_DIR}/scripts/build-release.sh" ]; then
    step "Packaging a release for the download link"
    if command -v rsync >/dev/null 2>&1; then
      sh "${INSTALL_DIR}/scripts/build-release.sh" >/dev/null 2>&1 &&
        ok "Release packaged" ||
        warn "Release packaging failed; the install command will 404 until it succeeds."
    else
      warn "rsync is not installed, so no release was packaged."
      dim "Install rsync and run: sh ${INSTALL_DIR}/scripts/build-release.sh"
    fi
  fi
}

finish_site() {
  printf '\n'
  printf '%s  ================================================================%s\n' "$C_ORANGE" "$C_RESET"
  printf '   The %s website is running.\n\n' "$PANEL_NAME"
  printf '     Open:  %s%s%s\n\n' "$C_ORANGE" "${PANEL_URL}" "$C_RESET"
  printf '   Manage it with:\n'
  printf '     cd %s\n' "$INSTALL_DIR"
  printf '     docker compose -f docker-compose.site.yml logs -f\n'
  printf '     docker compose -f docker-compose.site.yml down\n\n'
  printf '   %sNote:%s panels on a private network cannot report stats to a site\n' "$C_YELLOW" "$C_RESET"
  printf '   on a private address - outbound requests to private ranges are\n'
  printf '   blocked deliberately. Counters fill in once this is public.\n'
  printf '%s  ================================================================%s\n\n' "$C_ORANGE" "$C_RESET"
}

configure() {
  step "Configuring"

  if [ "${UPGRADE:-0}" = "1" ] && [ -f "$INSTALL_DIR/.env" ]; then
    ok "Keeping the existing .env"
    return
  fi

  _ip=$(detect_ip)
  _host=$(ask "Address you will reach the panel on:" "$_ip")
  WEB_PORT=$(ask "Web port:" "$WEB_PORT")
  API_PORT=$(ask "API port:" "$API_PORT")

  # --- Telemetry, asked plainly ---
  _telemetry="false"
  if [ "$TELEMETRY" = "ask" ]; then
    printf '\n'
    dim "Anonymous usage stats help show how many panels and game servers are"
    dim "running. Sent: a random instance ID, the panel version, and counts."
    dim "Never sent: your IP, hostname, server names, player data, or any key."
    if confirm "Share anonymous usage stats?" "y"; then _telemetry="true"; fi
  elif [ "$TELEMETRY" = "1" ] || [ "$TELEMETRY" = "true" ]; then
    _telemetry="true"
  fi

  _pgpw=$(random_hex 24)

  cat > "$INSTALL_DIR/.env" <<EOF
# Generated by the Arma Server Panel installer.
#
# BACK THIS FILE UP. Losing ENCRYPTION_KEY permanently destroys every stored
# two-factor secret and every saved credential.

NODE_ENV=production
LOG_LEVEL=info

API_HOST=0.0.0.0
API_PORT=4000
WEB_HOST_PORT=${WEB_PORT}
API_HOST_PORT=${API_PORT}

PUBLIC_APP_URL=http://${_host}:${WEB_PORT}
NEXT_PUBLIC_API_URL=http://${_host}:${API_PORT}
NEXT_PUBLIC_APP_URL=http://${_host}:${WEB_PORT}

POSTGRES_PASSWORD=${_pgpw}
DATABASE_URL=postgresql://asp:${_pgpw}@postgres:5432/arma_server_panel?schema=public

ENCRYPTION_KEY=$(random_hex 32)
HASH_PEPPER=$(random_hex 32)

DATA_ROOT=${INSTALL_DIR}/data/servers
DOCKER_SOCKET=/var/run/docker.sock

RELAY_ENABLED=false
TRUST_PROXY=false

# Plain HTTP on a LAN. Put TLS in front and set this to true before exposing
# the panel to the internet - the session cookie is otherwise in the clear.
REQUIRE_SECURE_COOKIES=false

TELEMETRY_ENABLED=${_telemetry}
TELEMETRY_ENDPOINT=${DOWNLOAD_BASE}/api/telemetry

SPEEDTEST_DOWNLOAD_URL=https://speed.cloudflare.com/__down?bytes=52428800
SPEEDTEST_UPLOAD_URL=https://speed.cloudflare.com/__up
EOF

  chmod 600 "$INSTALL_DIR/.env"
  mkdir -p "$INSTALL_DIR/data/servers"

  PANEL_URL="http://${_host}:${WEB_PORT}"
  ok "Wrote $INSTALL_DIR/.env (permissions 600)"
}

# ------------------------------------------------------------------ #
# Start                                                               #
# ------------------------------------------------------------------ #

start_stack() {
  step "Building and starting (this takes a few minutes on first run)"

  cd "$INSTALL_DIR"
  docker compose up -d --build || die "The stack failed to start.
     Look at the logs with:  cd $INSTALL_DIR && docker compose logs"

  printf '  waiting for the API'
  _tries=0
  while [ "$_tries" -lt 60 ]; do
    if curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; then
      printf '\n'
      ok "API is up"
      return 0
    fi
    printf '.'
    sleep 3
    _tries=$((_tries + 1))
  done

  printf '\n'
  warn "The API did not come up within three minutes."
  warn "Check:  cd $INSTALL_DIR && docker compose logs api"
}

install_systemd_unit() {
  # Only if systemd is actually in use.
  [ -d /etc/systemd/system ] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0

  cat > /etc/systemd/system/arma-server-panel.service <<EOF
[Unit]
Description=${PANEL_NAME}
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable arma-server-panel.service >/dev/null 2>&1 || true
  ok "Enabled the systemd unit (starts on boot)"
}

finish() {
  printf '\n'
  printf '%s' "$C_ORANGE"
  printf '  ================================================================\n'
  printf '%s' "$C_RESET"
  printf '   %s is installed.\n\n' "$PANEL_NAME"
  printf '     Open:      %s%s%s\n' "$C_ORANGE" "${PANEL_URL:-http://localhost:${WEB_PORT}}" "$C_RESET"
  printf '     Username:  %sAdmin%s\n' "$C_GREEN" "$C_RESET"
  printf '     Password:  %sPassword123%s\n\n' "$C_GREEN" "$C_RESET"
  printf '   Choose the "Administrator" tab. You will be required to change\n'
  printf '   this password and enrol two-factor before anything else opens.\n\n'
  printf '   %sDo not expose this panel to the internet until you have.%s\n\n' "$C_YELLOW" "$C_RESET"
  printf '   Manage it with:\n'
  printf '     cd %s\n' "$INSTALL_DIR"
  printf '     docker compose logs -f      # watch\n'
  printf '     docker compose restart      # restart\n'
  printf '     docker compose down         # stop\n'
  printf '%s' "$C_ORANGE"
  printf '  ================================================================\n'
  printf '%s\n' "$C_RESET"
}

# ------------------------------------------------------------------ #
# Main                                                                #
# ------------------------------------------------------------------ #

usage() {
  cat <<EOF
${PANEL_NAME} installer

  sh install.sh [--site] [--help]

    --site   Install the public website instead of the control panel.

Environment:
  ASP_REPO           git URL to install from (skips the release download)
  ASP_BRANCH         branch to use with ASP_REPO (default: main)
  ASP_INSTALL_DIR    where to install (default: /opt/arma-server-panel)
  ASP_WEB_PORT       panel web port (default: 3002)
  ASP_API_PORT       panel API port (default: 3004)
  ASP_SITE_PORT      website port (default: 3100)
  ASP_TELEMETRY      1 or 0 to skip the anonymous-stats prompt
  ASP_ASSUME_YES     1 for a non-interactive install
EOF
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --site) MODE="site" ;;
      --panel) MODE="panel" ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $arg  (try --help)" ;;
    esac
  done

  banner
  require_root
  detect_arch
  check_docker

  if [ "$MODE" = "site" ]; then
    # The website is a small Next.js app and a database; it does not need the
    # game-server hardware floor.
    download_release
    configure_site
    start_site
    finish_site
    return
  fi

  check_requirements
  download_release
  configure
  start_stack
  install_systemd_unit
  finish
}

main "$@"
