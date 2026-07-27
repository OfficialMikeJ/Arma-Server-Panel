# Arma 4 dedicated server - placeholder
#
# Arma 4 has not shipped, so there is no server package to install and no
# published system requirements. This image exists so the platform has a
# complete, buildable target the day it launches: set STEAM_APP_ID, and the
# entrypoint's SteamCMD call works unchanged.
#
# The panel refuses to provision Arma 4 servers while GAMES.arma4.released is
# false, so building this image has no effect until that flips.
#
# Build:  docker build -t asp/arma4:latest docker/arma4

FROM debian:bookworm-slim AS steamcmd

ARG DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 \
 && rm -rf /var/lib/apt/lists/*

# SteamCMD download.
#
# Valve's documented host first, with the older CDN alias as a fallback:
# that alias intermittently refuses requests, and when it does the image
# build fails with nothing but a curl exit code to go on.
RUN mkdir -p /opt/steamcmd \
 && ( curl -fsSL https://media.steampowered.com/client/installer/steamcmd_linux.tar.gz \
      || curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz ) \
    | tar -xz -C /opt/steamcmd


FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG UID=1000
ARG GID=1000

# Enfusion runtime dependencies, matching Reforger. Adjust on launch if the
# real requirements differ.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      lib32gcc-s1 \
      libatomic1 \
      libcurl4 \
      libpulse0 \
      libvulkan1 \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

COPY --from=steamcmd /opt/steamcmd /opt/steamcmd

RUN groupadd --gid ${GID} steam \
 && useradd --uid ${UID} --gid ${GID} --create-home --home-dir /home/steam --shell /usr/sbin/nologin steam \
 && mkdir -p /home/steam/server \
 && chown -R steam:steam /home/steam /opt/steamcmd

COPY --chown=steam:steam entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh

USER 1000:1000
WORKDIR /home/steam/server

# Set once Bohemia publishes the dedicated server app id.
ENV STEAM_APP_ID="" \
    SERVER_BINARY=Arma4Server \
    LANG=C.UTF-8

EXPOSE 2001/udp 17777/udp 19999/udp

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
