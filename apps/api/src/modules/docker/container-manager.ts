/**
 * Container lifecycle operations.
 *
 * Every method here is idempotent where it can be, because power actions
 * arrive from a UI where a user may double-click, and from an HTTP API where
 * a client may retry.
 */

import type Docker from 'dockerode';
import type { Duplex, Readable } from 'node:stream';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getGame, type GameId } from '@asp/shared';
import { loadConfig } from '../../config/env.js';
import { requireDocker } from './docker-client.js';
import {
  CONTAINER_GID,
  CONTAINER_UID,
  SERVER_NETWORK_NAME,
  buildContainerSpec,
  buildNetworkSpec,
  type ContainerSpecInput,
} from './container-spec.js';
import { logger } from '../../lib/logger.js';
import { AppError, serviceUnavailable } from '../../lib/errors.js';

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
  restartCount: number;
}

export async function ensureServerNetwork(): Promise<void> {
  const docker = await requireDocker();
  const networks = await docker.listNetworks({ filters: { name: [SERVER_NETWORK_NAME] } });
  if (networks.some((n) => n.Name === SERVER_NETWORK_NAME)) return;

  logger.info({ network: SERVER_NETWORK_NAME }, 'Creating isolated server network');
  await docker.createNetwork(buildNetworkSpec());
}

export async function createContainer(input: ContainerSpecInput): Promise<string> {
  const docker = await requireDocker();
  await ensureServerNetwork();

  // Remove any stale container with the same name from a failed prior attempt.
  await removeContainer(input.containerName, { force: true }).catch(() => undefined);

  const container = await docker.createContainer(buildContainerSpec(input));
  logger.info({ container: input.containerName, id: container.id }, 'Container created');
  return container.id;
}

async function getContainer(nameOrId: string): Promise<Docker.Container | null> {
  const docker = await requireDocker();
  const container = docker.getContainer(nameOrId);
  try {
    await container.inspect();
    return container;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}

export async function inspectContainer(nameOrId: string): Promise<ContainerStatus> {
  const container = await getContainer(nameOrId);
  if (!container) {
    return {
      exists: false,
      running: false,
      status: 'missing',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      oomKilled: false,
      restartCount: 0,
    };
  }

  const info = await container.inspect();
  return {
    exists: true,
    running: info.State.Running,
    status: info.State.Status,
    exitCode: info.State.ExitCode ?? null,
    startedAt: info.State.StartedAt ?? null,
    finishedAt: info.State.FinishedAt ?? null,
    oomKilled: info.State.OOMKilled ?? false,
    restartCount: info.RestartCount ?? 0,
  };
}

export async function startContainer(nameOrId: string): Promise<void> {
  const container = await getContainer(nameOrId);
  if (!container) throw new AppError(409, 'container_missing', 'This server has not been installed yet.');

  const status = await container.inspect();
  if (status.State.Running) return;

  await container.start();
  logger.info({ container: nameOrId }, 'Container started');
}

/**
 * Graceful stop: SIGTERM, then SIGKILL after the timeout. Arma servers save
 * state on SIGTERM, so the grace period matters.
 */
export async function stopContainer(nameOrId: string, timeoutSeconds = 30): Promise<void> {
  const container = await getContainer(nameOrId);
  if (!container) return;

  const status = await container.inspect();
  if (!status.State.Running) return;

  try {
    await container.stop({ t: timeoutSeconds });
  } catch (error) {
    // 304 = already stopped, which is a success for our purposes.
    if ((error as { statusCode?: number }).statusCode !== 304) throw error;
  }
  logger.info({ container: nameOrId }, 'Container stopped');
}

export async function killContainer(nameOrId: string): Promise<void> {
  const container = await getContainer(nameOrId);
  if (!container) return;
  try {
    await container.kill({ signal: 'SIGKILL' });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 409) throw error;
  }
  logger.warn({ container: nameOrId }, 'Container killed');
}

export async function restartContainer(nameOrId: string, timeoutSeconds = 30): Promise<void> {
  const container = await getContainer(nameOrId);
  if (!container) throw new AppError(409, 'container_missing', 'This server has not been installed yet.');
  await container.restart({ t: timeoutSeconds });
  logger.info({ container: nameOrId }, 'Container restarted');
}

export async function removeContainer(
  nameOrId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const container = await getContainer(nameOrId);
  if (!container) return;
  await container.remove({ force: options.force ?? false, v: false });
  logger.info({ container: nameOrId }, 'Container removed');
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

export interface LogStreamOptions {
  tail?: number;
  since?: number;
  follow: boolean;
}

export async function getLogStream(
  nameOrId: string,
  options: LogStreamOptions,
): Promise<Readable> {
  const container = await getContainer(nameOrId);
  if (!container) throw new AppError(409, 'container_missing', 'This server is not installed.');

  const stream = await container.logs({
    follow: options.follow as true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: options.tail ?? 200,
    ...(options.since ? { since: options.since } : {}),
  });

  return stream as unknown as Readable;
}

/**
 * Demultiplexes Docker's stream framing.
 *
 * Without a TTY, Docker prefixes each frame with an 8-byte header:
 * [stream_type, 0, 0, 0, size_be32]. Naively concatenating the stream leaves
 * those bytes inline and corrupts the output.
 */
export function demuxDockerStream(
  chunk: Buffer,
  onLine: (stream: 'stdout' | 'stderr', text: string) => void,
  carry: { buffer: Buffer },
): void {
  carry.buffer = Buffer.concat([carry.buffer, chunk]);

  for (;;) {
    if (carry.buffer.length < 8) return;

    const streamType = carry.buffer[0]!;
    const size = carry.buffer.readUInt32BE(4);

    // A frame larger than 16 MiB means we have lost sync; drop and resync.
    if (size > 16 * 1024 * 1024) {
      carry.buffer = Buffer.alloc(0);
      return;
    }
    if (carry.buffer.length < 8 + size) return;

    const payload = carry.buffer.subarray(8, 8 + size).toString('utf8');
    carry.buffer = carry.buffer.subarray(8 + size);

    const kind = streamType === 2 ? 'stderr' : 'stdout';
    for (const line of payload.split('\n')) {
      if (line.length > 0) onLine(kind, line);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

export interface ContainerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export async function sampleStats(nameOrId: string): Promise<ContainerStats | null> {
  const container = await getContainer(nameOrId);
  if (!container) return null;

  const raw = (await container.stats({ stream: false })) as Docker.ContainerStats;

  const cpuDelta =
    (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCount =
    raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

  // `usage` includes page cache, which makes a healthy server look like it is
  // about to OOM. Subtract it for a number that means something.
  const memStats = raw.memory_stats ?? {};
  const cache =
    (memStats.stats as Record<string, number> | undefined)?.inactive_file ??
    (memStats.stats as Record<string, number> | undefined)?.cache ??
    0;
  const memoryBytes = Math.max(0, (memStats.usage ?? 0) - cache);

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    netRxBytes += iface.rx_bytes ?? 0;
    netTxBytes += iface.tx_bytes ?? 0;
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (entry.op?.toLowerCase() === 'read') blockReadBytes += entry.value ?? 0;
    if (entry.op?.toLowerCase() === 'write') blockWriteBytes += entry.value ?? 0;
  }

  return {
    cpuPercent: Math.min(cpuPercent, cpuCount * 100),
    memoryBytes,
    memoryLimitBytes: memStats.limit ?? 0,
    netRxBytes,
    netTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids: raw.pids_stats?.current ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Exec                                                                */
/* ------------------------------------------------------------------ */

/**
 * Runs a command inside a container.
 *
 * `argv` is an array and is passed straight to exec - there is no shell, so
 * nothing in it can be interpreted as a shell metacharacter. Callers must
 * never build a single "sh -c" string from user input.
 */
export async function execInContainer(
  nameOrId: string,
  argv: string[],
  options: { timeoutMs?: number; user?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (argv.length === 0) throw new Error('execInContainer requires at least one argument');

  const container = await getContainer(nameOrId);
  if (!container) throw serviceUnavailable('The server container is not available.');

  const exec = await container.exec({
    Cmd: argv,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: false,
    User: options.user ?? `${CONTAINER_UID}:${CONTAINER_GID}`,
    Env: [],
  });

  const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as Duplex;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const carry = { buffer: Buffer.alloc(0) };

  const timeoutMs = options.timeoutMs ?? 60_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new AppError(504, 'exec_timeout', 'The command took too long and was cancelled.'));
    }, timeoutMs);

    stream.on('data', (chunk: Buffer) => {
      demuxDockerStream(chunk, (kind, text) => {
        (kind === 'stderr' ? stderr : stdout).push(text);
      }, carry);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

/** Pulls an image, streaming progress to the log. */
export async function pullImage(image: string): Promise<void> {
  const docker = await requireDocker();
  logger.info({ image }, 'Pulling image');

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, {}, (error: Error | null, stream?: NodeJS.ReadableStream) => {
      if (error) return reject(error);
      if (!stream) return reject(new Error(`Docker returned no progress stream for ${image}`));
      docker.modem.followProgress(stream, (doneError: Error | null) => {
        if (doneError) return reject(doneError);
        resolve();
      });
    });
  });
}

export async function imageExists(image: string): Promise<boolean> {
  const docker = await requireDocker();
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a game server image if it is not already present.
 *
 * These images are large and slow to build (SteamCMD downloads the whole game
 * server package), so they are built on first use rather than at install time.
 * Someone who only ever runs Reforger should not wait for the Arma 3 image.
 *
 * `onProgress` receives build output line by line, which the caller pipes into
 * the server console so the operator can watch rather than stare at a spinner.
 */
/**
 * Fingerprint of the build inputs.
 *
 * Stored as a label on the image and compared before reuse, so editing a
 * Dockerfile or entrypoint actually rebuilds. Checking only whether the tag
 * exists means a fixed image is never picked up - which is how a container
 * kept running as the wrong uid long after the fix was deployed.
 */
async function buildFingerprint(contextDir: string): Promise<string> {
  const hash = createHash('sha256');

  for (const name of ['Dockerfile', 'entrypoint.sh']) {
    try {
      hash.update(await readFile(path.join(contextDir, name)));
    } catch {
      hash.update(`missing:${name}`);
    }
  }

  return hash.digest('hex').slice(0, 16);
}

const FINGERPRINT_LABEL = 'io.armaserverpanel.build-fingerprint';

export async function ensureGameImage(
  gameId: GameId,
  onProgress?: (line: string) => void,
): Promise<void> {
  const game = getGame(gameId);
  const image = game.image;

  const config = loadConfig();
  const contextDir = path.join(config.GAME_IMAGE_ROOT, gameId);
  const fingerprint = await buildFingerprint(contextDir);

  if (await imageExists(image)) {
    const docker = await requireDocker();
    const info = await docker.getImage(image).inspect().catch(() => null);
    const existing = info?.Config?.Labels?.[FINGERPRINT_LABEL];

    if (existing === fingerprint) return;

    onProgress?.(
      existing
        ? 'The build files for this game changed since the image was built. Rebuilding.'
        : 'This image predates build fingerprinting. Rebuilding once to pick up any fixes.',
    );
    logger.info({ image, existing, fingerprint }, 'Game image is stale, rebuilding');
  }

  // A clear message here beats a raw ENOENT from the Docker daemon.
  try {
    await access(path.join(contextDir, 'Dockerfile'));
  } catch {
    throw serviceUnavailable(
      `The build files for ${game.name} are not available to the panel ` +
        `(looked in ${contextDir}). Check that the repository's docker/ directory is mounted ` +
        `into the API container.`,
    );
  }

  const docker = await requireDocker();
  onProgress?.(`Building the ${game.name} server image. This takes several minutes the first time.`);
  logger.info({ image, contextDir }, 'Building game image');

  const stream = await docker.buildImage(
    { context: contextDir, src: ['Dockerfile', 'entrypoint.sh'] },
    {
      t: image,
      rm: true,
      forcerm: true,
      labels: { [FINGERPRINT_LABEL]: fingerprint },
    },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (error: Error | null, output: Array<Record<string, unknown>>) => {
        if (error) return reject(error);

        // followProgress resolves even when the build failed; the failure is
        // reported as an `error` entry in the output stream.
        const failure = output.find((entry) => typeof entry.error === 'string');
        if (failure) {
          return reject(new Error(String(failure.error).slice(0, 500)));
        }
        resolve();
      },
      (event: Record<string, unknown>) => {
        if (typeof event.stream === 'string') {
          const line = event.stream.trim();
          if (line) onProgress?.(line);
        } else if (typeof event.error === 'string') {
          onProgress?.(`Build error: ${event.error}`);
        }
      },
    );
  });

  if (!(await imageExists(image))) {
    throw serviceUnavailable(`The ${game.name} image failed to build.`);
  }

  onProgress?.(`${game.name} image built.`);
  logger.info({ image }, 'Game image built');
}
