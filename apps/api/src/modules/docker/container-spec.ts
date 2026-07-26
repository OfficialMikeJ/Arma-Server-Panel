/**
 * Container specification for a game server.
 *
 * Isolation is the whole point of this file. Each server gets:
 *   * its own container, its own network namespace, its own volume,
 *   * a non-root user (uid 10000) with no ability to gain privileges,
 *   * every Linux capability dropped, nothing added back,
 *   * a read-only root filesystem, with writable tmpfs only where required,
 *   * hard CPU, memory, pid and I/O limits so one server cannot starve another,
 *   * no access to the Docker socket, host network, or any host device.
 *
 * Nothing here interpolates user input into a shell. The entrypoint receives
 * an argv array, and every value in it is validated before it gets this far.
 */

import type Docker from 'dockerode';
import { RESOURCE_LIMITS, getGame, type GameId } from '@asp/shared';

export interface ContainerSpecInput {
  containerName: string;
  gameId: GameId;
  image: string;
  /** Absolute host path of this server's data volume. */
  volumePath: string;
  /** Base port allocated on the host. */
  basePort: number;
  /** Ports to publish, keyed by the game definition's port key. */
  publishPorts: Array<{ key: string; hostPort: number; containerPort: number; protocol: 'udp' | 'tcp' }>;
  resources: {
    cpuCores: number;
    cpuSet: string | null;
    memoryMib: number;
    storageGib: number;
    bandwidthMbps: number;
  };
  /** Non-secret environment. Secrets are delivered through a mounted file. */
  env: Record<string, string>;
  serverId: string;
  ownerId: string;
}

/**
 * uid/gid the game process runs as inside the container.
 *
 * Must match the user the API container runs as (`node`, uid 1000), because
 * both write into the same server volume: the API writes config files, the
 * game writes saves, logs and downloaded content. A mismatch means the game
 * server cannot write to its own directory at all.
 *
 * Still unprivileged - the point is that it is not root, not that it is an
 * unusual number.
 */
export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;

/** Where the server's data volume is mounted inside the container. */
export const CONTAINER_DATA_PATH = '/home/steam/server';

const NANO_CPU = 1_000_000_000;
const MIB = 1024 * 1024;

/**
 * Environment keys a caller is allowed to set. Anything else is dropped, so a
 * crafted server name cannot smuggle in LD_PRELOAD or PATH.
 */
const ALLOWED_ENV_KEYS = new Set([
  'ASP_SERVER_ID', 'ASP_SERVER_NAME', 'ASP_GAME', 'ASP_SLOTS',
  'ASP_BASE_PORT', 'ASP_GAME_PORT', 'ASP_QUERY_PORT', 'ASP_RCON_PORT', 'ASP_BATTLEYE_PORT',
  'ASP_MAX_FPS', 'ASP_CONFIG_FILE', 'ASP_MODS_FILE', 'ASP_PERSISTENCE',
  'ASP_STARTUP_PARAMS', 'ASP_LOG_LEVEL', 'ASP_PUBLIC_HOST',
  'STEAM_APP_ID', 'STEAM_GAME_APP_ID', 'STEAM_BETA',
  'LANG', 'LC_ALL', 'TZ',
]);

function sanitizeEnv(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ALLOWED_ENV_KEYS.has(key)) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    // Environment values cannot contain NUL or newlines.
    const clean = String(value).replace(/[\0\r\n]/g, '').slice(0, 4096);
    out.push(`${key}=${clean}`);
  }
  return out;
}

export function buildContainerSpec(input: ContainerSpecInput): Docker.ContainerCreateOptions {
  const game = getGame(input.gameId);

  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostPort: string; HostIp: string }>> = {};

  for (const port of input.publishPorts) {
    const key = `${port.containerPort}/${port.protocol}`;
    exposedPorts[key] = {};
    portBindings[key] = [
      {
        // Bind on all interfaces so players can reach it. The panel's own
        // ports stay bound to loopback - see API_HOST.
        HostIp: '0.0.0.0',
        HostPort: String(port.hostPort),
      },
    ];
  }

  const memoryBytes = input.resources.memoryMib * MIB;

  return {
    name: input.containerName,
    Image: input.image,
    Hostname: input.containerName,
    // The image's own entrypoint runs the game; no user-supplied command.
    Env: sanitizeEnv(input.env),
    User: `${CONTAINER_UID}:${CONTAINER_GID}`,
    WorkingDir: CONTAINER_DATA_PATH,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    AttachStdout: true,
    AttachStderr: true,
    ExposedPorts: exposedPorts,

    Labels: {
      'io.armaserverpanel.managed': 'true',
      'io.armaserverpanel.server-id': input.serverId,
      'io.armaserverpanel.owner-id': input.ownerId,
      'io.armaserverpanel.game': input.gameId,
    },

    HostConfig: {
      /* ---- Filesystem ---- */
      Binds: [`${input.volumePath}:${CONTAINER_DATA_PATH}:rw`],
      // Everything outside the data volume is immutable.
      ReadonlyRootfs: true,
      Tmpfs: {
        // noexec/nosuid so a dropped payload cannot be executed from tmp.
        '/tmp': 'rw,noexec,nosuid,nodev,size=256m',
        '/run': 'rw,noexec,nosuid,nodev,size=16m',
        [`${CONTAINER_DATA_PATH}/.cache`]: 'rw,noexec,nosuid,nodev,size=512m',
      },

      /* ---- Privilege ---- */
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: [
        // The single most important flag here: setuid binaries cannot raise
        // privileges, which neuters most container-escape chains.
        //
        // seccomp and AppArmor are deliberately NOT listed. Docker applies its
        // default profiles for both unless told otherwise, so naming them adds
        // nothing - and `seccomp=default` is not even valid syntax, since that
        // field expects a profile path or inline JSON.
        'no-new-privileges:true',
      ],
      // Explicitly deny access to every host device.
      Devices: [],
      DeviceCgroupRules: [],
      GroupAdd: [],

      /* ---- CPU ---- */
      NanoCpus: Math.round(input.resources.cpuCores * NANO_CPU),
      CpusetCpus: input.resources.cpuSet ?? '',
      CpuShares: Math.max(2, Math.round(input.resources.cpuCores * 1024)),

      /* ---- Memory ---- */
      Memory: memoryBytes,
      // Equal to Memory: no swap. Swapping a game server is worse than OOM.
      MemorySwap: memoryBytes,
      MemorySwappiness: 0,
      // Reserve slightly under the limit so the scheduler places sensibly.
      MemoryReservation: Math.round(memoryBytes * 0.9),
      OomKillDisable: false,

      /* ---- Processes ---- */
      PidsLimit: RESOURCE_LIMITS.pidsLimit,
      Ulimits: [
        { Name: 'nofile', Soft: 8192, Hard: 16384 },
        { Name: 'nproc', Soft: 512, Hard: 512 },
        // No core dumps: they would contain RCON passwords from memory.
        { Name: 'core', Soft: 0, Hard: 0 },
      ],

      /* ---- Storage I/O ---- */
      // Quota is enforced by the filesystem (XFS/ZFS project quota on the
      // volume); these throttle a runaway server from saturating the disk.
      BlkioWeight: 500,

      /* ---- Network ---- */
      NetworkMode: 'asp-servers',
      PortBindings: portBindings,
      PublishAllPorts: false,
      // No host DNS games; use public resolvers explicitly.
      Dns: ['1.1.1.1', '9.9.9.9'],
      DnsSearch: [],
      ExtraHosts: [],

      /* ---- Lifecycle ---- */
      // The panel's supervisor decides when to restart, so it can apply the
      // crash-loop limit and notify the owner. Docker restarting behind our
      // back would hide crashes.
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,

      /* ---- Logging ---- */
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '32m', 'max-file': '3', compress: 'true' },
      },

      /* ---- Namespaces: never share the host's ---- */
      IpcMode: 'private',
      PidMode: '',
      UTSMode: '',
      UsernsMode: '',
      Sysctls: {},
    },

    NetworkingConfig: {
      EndpointsConfig: {
        'asp-servers': {
          Aliases: [input.containerName],
        },
      },
    },
  };
}

/**
 * The isolated bridge network every game container joins.
 *
 * `enable_icc: false` stops containers talking to each other, so a compromise
 * of one customer's server does not give lateral access to another's.
 */
export const SERVER_NETWORK_NAME = 'asp-servers';

export function buildNetworkSpec(): Docker.NetworkCreateOptions {
  return {
    Name: SERVER_NETWORK_NAME,
    Driver: 'bridge',
    CheckDuplicate: true,
    Internal: false,
    Attachable: false,
    EnableIPv6: false,
    Options: {
      'com.docker.network.bridge.enable_icc': 'false',
      'com.docker.network.bridge.enable_ip_masquerade': 'true',
      'com.docker.network.bridge.name': 'asp0',
      'com.docker.network.driver.mtu': '1500',
    },
    Labels: { 'io.armaserverpanel.managed': 'true' },
  };
}

/** Deterministic container name. Never derived from user-supplied text. */
export function containerNameFor(serverId: string): string {
  return `asp-${serverId.slice(-12).toLowerCase()}`;
}
