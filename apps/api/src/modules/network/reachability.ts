/**
 * External reachability verification.
 *
 * Opening a port and *being reachable* are different things - a mapping can
 * succeed while an ISP still blocks the port, or while the game process is not
 * yet listening. The panel therefore queries the server through its own public
 * address, the same way a player's client would.
 *
 * The check runs against the address we published, so it exercises the real
 * path including any relay.
 */

import { GAMES } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { queryA2SInfo } from '../games/protocols/a2s.js';
import { toGameId } from '../servers/server-service.js';

export interface ReachabilityResult {
  portKey: string;
  externalPort: number;
  protocol: string;
  reachable: boolean;
  latencyMs: number | null;
  message: string;
}

export async function probeReachability(serverId: string): Promise<ReachabilityResult[]> {
  const server = await prisma.server.findFirst({
    where: { id: serverId, deletedAt: null },
    include: { ports: true },
  });
  if (!server) return [];

  const gameId = toGameId(server.game);
  const results: ReachabilityResult[] = [];

  if (server.state !== 'RUNNING') {
    return server.ports
      .filter((port) => GAMES[gameId].ports.find((p) => p.key === port.portKey)?.public)
      .map((port) => ({
        portKey: port.portKey,
        externalPort: port.externalPort,
        protocol: port.protocol,
        reachable: false,
        latencyMs: null,
        message: 'The server is not running, so reachability cannot be verified.',
      }));
  }

  for (const port of server.ports) {
    const spec = GAMES[gameId].ports.find((p) => p.key === port.portKey);
    if (!spec?.public) continue;

    // Only the query port answers a protocol we can speak from outside.
    if (port.portKey !== 'steamQuery' && port.portKey !== 'a2s') {
      results.push({
        portKey: port.portKey,
        externalPort: port.externalPort,
        protocol: port.protocol,
        reachable: port.active,
        latencyMs: null,
        message: port.active
          ? 'Mapping is in place. This port carries game traffic and cannot be probed directly.'
          : 'No mapping is active for this port.',
      });
      continue;
    }

    const info = await queryA2SInfo(server.publicHost, port.externalPort, 4000).catch(() => null);

    const result: ReachabilityResult = {
      portKey: port.portKey,
      externalPort: port.externalPort,
      protocol: port.protocol,
      reachable: info !== null,
      latencyMs: info?.ping ?? null,
      message: info
        ? `Reachable from outside. The server answered as "${info.name}" with ${info.players}/${info.maxPlayers} players.`
        : 'No answer on the public address. The port may be blocked upstream, or the game may not be listening yet.',
    };

    results.push(result);

    await prisma.portAllocation
      .update({
        where: { id: port.id },
        data: {
          reachable: result.reachable,
          lastVerifiedAt: new Date(),
          message: result.message,
        },
      })
      .catch((error) => logger.debug({ err: error }, 'Could not record reachability result'));
  }

  return results;
}
