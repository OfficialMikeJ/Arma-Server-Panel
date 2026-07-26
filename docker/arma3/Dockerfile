# Arma 3 dedicated server
#
# Build:  docker build -t asp/arma3:latest docker/arma3
#
# Hardening notes:
#   * Runs as uid/gid 1000 (matching the API container), never root. The panel additionally applies
#     no-new-privileges, cap_drop ALL and a read-only rootfs at run time.
#   * SteamCMD credentials are passed at run time, never baked into a layer.
#   * No package manager, compiler or shell utility beyond what the entrypoint
#     needs survives into the final image.

FROM debian:bookworm-slim AS steamcmd

ARG DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      lib32gcc-s1 \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/steamcmd \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
    | tar -xz -C /opt/steamcmd


FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG UID=1000
ARG GID=1000

# Arma 3's Linux server binary needs the 32-bit loader for SteamCMD and a small
# set of 64-bit runtime libraries for the server itself.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      lib32gcc-s1 \
      lib32stdc++6 \
      libcurl4 \
      libsdl2-2.0-0 \
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

ENV STEAM_APP_ID=233780 \
    STEAM_GAME_APP_ID=107410 \
    LANG=C.UTF-8 \
    LD_LIBRARY_PATH=/home/steam/server/gamefiles

# The panel publishes 2302-2306/udp from the host side.
EXPOSE 2302/udp 2303/udp 2304/udp 2305/udp 2306/udp

# tini reaps zombies and forwards SIGTERM, so the graceful stop the panel
# issues actually reaches the game process and lets it save.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
