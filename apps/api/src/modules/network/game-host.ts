/**
 * Where the panel finds its own game servers.
 *
 * The API talks to every server twice over: an A2S query for the player count,
 * and BattlEye/RCON for console commands. Both went to `127.0.0.1`, which is
 * correct only when the API runs directly on the host. In the supported
 * deployment it runs in a container of its own, so `127.0.0.1` is that
 * container's loopback - the game is in a different container entirely, and
 * `asp-servers` sets `enable_icc: false`, so it cannot be reached across the
 * game network either.
 *
 * What does work is the host: Docker publishes each game port there. From
 * inside a bridged container the host is the default gateway, so that address
 * is both where the panel reaches a published port *and* a safe bind address
 * for the ports that must not leave the machine.
 */

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { isContainerNetwork } from './nat-traversal.js';

const LOOPBACK = '127.0.0.1';

let cached: string | null = null;
let resolving: Promise<string> | null = null;

/**
 * Reads the container's default gateway from the routing table.
 *
 * `/proc/net/route` lists the gateway as a little-endian hex word, so 0x0102A8C0
 * is 192.168.2.1.
 */
async function readDefaultGateway(): Promise<string | null> {
  let table: string;
  try {
    table = await readFile('/proc/net/route', 'utf8');
  } catch {
    return null; // not Linux, or no procfs
  }

  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const destination = fields[1];
    const gateway = fields[2];
    if (destination !== '00000000' || !gateway || gateway === '00000000') continue;

    const word = Number.parseInt(gateway, 16);
    if (!Number.isFinite(word)) continue;

    return [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff].join('.');
  }

  return null;
}

async function resolve(): Promise<string> {
  const config = loadConfig();

  // An explicit override always wins - some operators run the API outside
  // Docker, or behind a routing setup we cannot infer.
  if (config.GAME_HOST_ADDRESS) return config.GAME_HOST_ADDRESS;

  // Running straight on the host: the published ports really are on loopback.
  if (!isContainerNetwork()) return LOOPBACK;

  const gateway = await readDefaultGateway();
  if (gateway) {
    logger.info({ gateway }, 'Reaching game servers through the container gateway');
    return gateway;
  }

  logger.warn(
    'Could not determine the container gateway. Player counts and console commands ' +
      'will not work until GAME_HOST_ADDRESS is set to this machine’s address.',
  );
  return LOOPBACK;
}

/**
 * The address the panel uses to reach a published game port, and the address
 * non-public ports (RCON, BattlEye) are bound to so they never reach the LAN.
 */
export async function getGameHost(): Promise<string> {
  if (cached) return cached;
  resolving ??= resolve().then((address) => {
    cached = address;
    return address;
  });
  return resolving;
}

/** Test/ops helper: forget the detected address so it is worked out again. */
export function resetGameHost(): void {
  cached = null;
  resolving = null;
}
