/**
 * Docker connection.
 *
 * The API talks to Docker over a unix socket by default, or over mutual TLS
 * for a remote node. Plain unauthenticated TCP is refused outright - an
 * exposed Docker API is root on the host.
 */

import Docker from 'dockerode';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { serviceUnavailable } from '../../lib/errors.js';

let client: Docker | null = null;

export async function getDocker(): Promise<Docker> {
  if (client) return client;

  const config = loadConfig();

  if (config.DOCKER_HOST) {
    const url = new URL(
      config.DOCKER_HOST.includes('://') ? config.DOCKER_HOST : `tcp://${config.DOCKER_HOST}`,
    );

    if (url.protocol === 'tcp:' || url.protocol === 'http:') {
      throw new Error(
        'Refusing to connect to a Docker daemon over unencrypted TCP. Use a unix socket or https with client certificates.',
      );
    }

    if (!config.DOCKER_TLS_CA || !config.DOCKER_TLS_CERT || !config.DOCKER_TLS_KEY) {
      throw new Error('DOCKER_HOST requires DOCKER_TLS_CA, DOCKER_TLS_CERT and DOCKER_TLS_KEY.');
    }

    const [ca, cert, key] = await Promise.all([
      readFile(config.DOCKER_TLS_CA),
      readFile(config.DOCKER_TLS_CERT),
      readFile(config.DOCKER_TLS_KEY),
    ]);

    client = new Docker({
      host: url.hostname,
      port: Number(url.port || 2376),
      protocol: 'https',
      ca,
      cert,
      key,
      version: 'v1.44',
    });
  } else {
    client = new Docker({ socketPath: config.DOCKER_SOCKET, version: 'v1.44' });
  }

  return client;
}

export interface DockerHealth {
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  /** True when the daemon reports user-namespace remapping is active. */
  userNsRemap: boolean;
  message: string | null;
}

/**
 * Last reported state of each daemon-level condition worth warning about.
 *
 * This function backs `/health`, which anything from a reverse proxy to a
 * monitoring agent will poll every few seconds. Warning on each call buried the
 * log in one repeated line - and these are properties of how dockerd was
 * started, so they cannot change without a restart that would restart the API
 * with it. Logged on transition instead: once at boot, and again only if the
 * answer actually changes.
 */
let lastUserNsRemap: boolean | null = null;
let dockerWasReachable: boolean | null = null;

export async function checkDockerHealth(): Promise<DockerHealth> {
  try {
    const docker = await getDocker();
    const [version, info] = await Promise.all([docker.version(), docker.info()]);

    const securityOptions: string[] = (info as { SecurityOptions?: string[] }).SecurityOptions ?? [];
    const userNsRemap = securityOptions.some((option) => option.includes('userns'));

    if (!userNsRemap && lastUserNsRemap !== false) {
      logger.warn(
        'Docker user-namespace remapping is not enabled. Enable it (dockerd --userns-remap=default) so a container escape does not land on host root.',
      );
    } else if (userNsRemap && lastUserNsRemap === false) {
      logger.info('Docker user-namespace remapping is now enabled.');
    }
    lastUserNsRemap = userNsRemap;

    if (dockerWasReachable === false) {
      logger.info('Docker is reachable again.');
    }
    dockerWasReachable = true;

    return {
      available: true,
      version: version.Version ?? null,
      apiVersion: version.ApiVersion ?? null,
      userNsRemap,
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Same treatment: a health probe against a daemon that is down should say
    // so once, not once per poll for as long as it stays down.
    if (dockerWasReachable !== false) {
      logger.error({ err: error }, 'Docker is not reachable');
    }
    dockerWasReachable = false;

    return { available: false, version: null, apiVersion: null, userNsRemap: false, message };
  }
}

/** Test/ops helper: forget what has already been reported. */
export function resetDockerHealthReporting(): void {
  lastUserNsRemap = null;
  dockerWasReachable = null;
}

export async function requireDocker(): Promise<Docker> {
  const health = await checkDockerHealth();
  if (!health.available) {
    throw serviceUnavailable(
      'The container runtime is not reachable. Game servers cannot be managed right now.',
    );
  }
  return getDocker();
}

/** Test seam. */
export function resetDockerClient(): void {
  client = null;
}
