/**
 * Port allocation.
 *
 * Games need a contiguous block of ports (game, query, RCON, ...), so the
 * allocator hands out a base port and derives the rest from the game's offset
 * table. Allocation is done inside a transaction with an advisory lock, so two
 * concurrent server creations cannot be handed the same block.
 */

import { PORT_ALLOCATION, getGame, type GameId } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { preconditionFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { releaseServerPortMappings } from './port-forwarder.js';

const ALLOCATOR_LOCK_ID = 991_204_733;

export interface AllocationResult {
  basePort: number;
  allocationIds: string[];
}

export async function allocatePorts(params: {
  nodeId: string;
  gameId: GameId;
  serverId: string;
}): Promise<AllocationResult> {
  const game = getGame(params.gameId);

  // What the game actually binds, versus the window reserved for it. Arma 3
  // touches five consecutive ports but Bohemia ask for 100 between instances,
  // so the block is far wider than the span - see GameDefinition.portBlock.
  const portSpan = Math.max(...game.ports.map((p) => p.offset)) + 1;
  const blockSize = Math.max(game.portBlock.stride, portSpan);

  return prisma.$transaction(async (tx) => {
    // Serialise allocation across concurrent requests.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOCATOR_LOCK_ID})`;

    const node = await tx.node.findUnique({
      where: { id: params.nodeId },
      select: { portRangeStart: true, portRangeEnd: true },
    });
    if (!node) throw preconditionFailed('Node not found.', 'node_missing');

    const taken = await tx.portAllocation.findMany({
      where: { nodeId: params.nodeId },
      select: { externalPort: true },
    });

    const used = new Set<number>(taken.map((t) => t.externalPort));
    for (const reserved of PORT_ALLOCATION.reserved) used.add(reserved);

    // Step by the block size so blocks never interleave, and check the whole
    // window - not just the ports we record - so a title that reserves elbow
    // room actually gets it.
    const scan = (from: number, to: number): number | null => {
      for (let candidate = from; candidate + blockSize - 1 <= to; candidate += blockSize) {
        let free = true;
        for (let offset = 0; offset < blockSize; offset += 1) {
          if (used.has(candidate + offset)) {
            free = false;
            break;
          }
        }
        if (free) return candidate;
      }
      return null;
    };

    // The title's own band first, so the first Arma 3 server lands on 2302 and
    // the first Reforger server on 2001 - the ports an operator setting this up
    // by hand would have used.
    let basePort = scan(
      game.portBlock.base,
      Math.min(game.portBlock.rangeEnd, node.portRangeEnd, PORT_ALLOCATION.max),
    );

    // Only if that band is full, or the operator has deliberately moved this
    // node's range away from it, fall back to the node's own range.
    if (basePort === null) {
      basePort = scan(
        Math.max(node.portRangeStart, PORT_ALLOCATION.min),
        Math.min(node.portRangeEnd, PORT_ALLOCATION.max),
      );
    }

    if (basePort === null) {
      throw preconditionFailed(
        'This node has no free port block left. Free a server or widen the node port range.',
        'no_ports_available',
      );
    }

    const allocationIds: string[] = [];
    for (const spec of game.ports) {
      const port = basePort + spec.offset;
      const created = await tx.portAllocation.create({
        data: {
          nodeId: params.nodeId,
          portKey: spec.key,
          protocol: spec.protocol,
          internalPort: port,
          externalPort: port,
          method: 'DIRECT',
          active: false,
          message: 'Allocated, not yet published',
        },
        select: { id: true },
      });
      allocationIds.push(created.id);
    }

    logger.info(
      { nodeId: params.nodeId, basePort, blockSize, game: params.gameId },
      'Allocated port block',
    );

    return { basePort, allocationIds };
  });
}

/** Removes router mappings, then frees the reservation. */
export async function releasePorts(serverId: string): Promise<void> {
  await releaseServerPortMappings(serverId).catch((error) => {
    logger.warn({ err: error, serverId }, 'Failed to remove port mappings before release');
  });
  await prisma.portAllocation.deleteMany({ where: { serverId } });
}

export async function getServerPorts(serverId: string) {
  return prisma.portAllocation.findMany({
    where: { serverId },
    orderBy: { internalPort: 'asc' },
  });
}
