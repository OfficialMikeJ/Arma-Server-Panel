#!/usr/bin/env bash
#
# Builds the release tarball that install.sh downloads.
#
#   ./scripts/build-release.sh
#
# Output:
#   apps/site/public/releases/stable/arma-server-panel.tar.gz
#   apps/site/public/releases/stable/arma-server-panel.tar.gz.sha256
#
# The tarball contains source only - no node_modules, no build output. The
# installer runs `docker compose up --build` on the target, so dependencies are
# resolved for that machine's architecture rather than the build machine's.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL="${1:-stable}"
OUT_DIR="${ROOT}/apps/site/public/releases/${CHANNEL}"
STAGE="$(mktemp -d)"
NAME="arma-server-panel"

trap 'rm -rf "$STAGE"' EXIT

echo "==> Staging ${NAME} (${CHANNEL})"

mkdir -p "${STAGE}/${NAME}"

# Everything the installer needs to build and run the panel.
for item in \
  package.json \
  package-lock.json \
  tsconfig.base.json \
  docker-compose.yml \
  .env.example \
  .gitattributes \
  README.md \
  SECURITY.md
do
  [ -e "${ROOT}/${item}" ] && cp "${ROOT}/${item}" "${STAGE}/${NAME}/"
done

# Source trees, minus anything machine-specific.
for dir in packages apps/api apps/web docker; do
  mkdir -p "${STAGE}/${NAME}/$(dirname "$dir")"
  rsync -a \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude 'dist' \
    --exclude '*.tsbuildinfo' \
    "${ROOT}/${dir}" "${STAGE}/${NAME}/$(dirname "$dir")/"
done

# The public website is not shipped to panel operators - it is this project's
# own site and has no place in someone else's deployment.
rm -rf "${STAGE}/${NAME}/apps/site"

echo "==> Verifying the staged tree"
test -f "${STAGE}/${NAME}/apps/api/prisma/schema.prisma" || { echo "missing prisma schema"; exit 1; }
test -d "${STAGE}/${NAME}/apps/api/prisma/migrations"    || { echo "missing migrations"; exit 1; }
test -f "${STAGE}/${NAME}/docker-compose.yml"            || { echo "missing compose file"; exit 1; }
test -f "${STAGE}/${NAME}/apps/web/next.config.mjs"      || { echo "missing web config"; exit 1; }

# A CRLF entrypoint fails inside a Linux container with an unhelpful error.
if grep -rlU $'\r' "${STAGE}/${NAME}" --include='*.sh' 2>/dev/null | grep -q .; then
  echo "ERROR: shell scripts contain CRLF line endings"
  exit 1
fi

echo "==> Packing"
mkdir -p "${OUT_DIR}"
tar -czf "${OUT_DIR}/${NAME}.tar.gz" -C "${STAGE}" "${NAME}"

( cd "${OUT_DIR}" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )

echo "==> Done"
ls -lh "${OUT_DIR}/${NAME}.tar.gz"
cat "${OUT_DIR}/${NAME}.tar.gz.sha256"
