/**
 * Game server lifecycle.
 *
 * This module owns every state transition. Routes validate and authorise, then
 * delegate here, so there is exactly one place where a server can change state
 * and exactly one place that has to get the locking right.
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  GAMES,
  RESOURCE_LIMITS,
  type CreateServerInput,
  type GameId,
  type ServerState,
} from '@asp/shared';
import type { Prisma, Server } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError, conflict, notFound, preconditionFailed } from '../../lib/errors.js';
import { encryptSecret, generateToken } from '../../security/crypto.js';
import { audit, AuditAction } from '../../security/audit.js';
import {
  containerNameFor,
  CONTAINER_DATA_PATH,
} from '../docker/container-spec.js';
import {
  createContainer,
  ensureGameImage,
  inspectContainer,
  killContainer,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from '../docker/container-manager.js';
import { emitPanelNotice, dropConsole } from './console-buffer.js';
import { allocatePorts, releasePorts } from '../network/port-allocator.js';
import { getAdapter } from '../games/registry.js';
import { assertHostRequirementsMet } from '../host/host-requirements.js';

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

const GAME_TITLE_BY_ID: Record<GameId, 'ARMA3' | 'REFORGER' | 'ARMA4'> = {
  arma3: 'ARMA3',
  reforger: 'REFORGER',
  arma4: 'ARMA4',
};

const GAME_ID_BY_TITLE: Record<string, GameId> = {
  ARMA3: 'arma3',
  REFORGER: 'reforger',
  ARMA4: 'arma4',
};

export function toGameId(title: string): GameId {
  const id = GAME_ID_BY_TITLE[title];
  if (!id) throw new Error(`Unknown game title ${title}`);
  return id;
}

/** Transitions each action is permitted from. */
const ALLOWED_TRANSITIONS: Record<string, ServerState[]> = {
  start: ['offline', 'crashed'],
  stop: ['running', 'starting', 'restarting', 'crashed'],
  restart: ['running', 'crashed'],
  kill: ['running', 'starting', 'stopping', 'restarting'],
  reinstall: ['offline', 'crashed', 'running'],
};

function toClientState(state: string): ServerState {
  return state.toLowerCase() as ServerState;
}

function assertTransition(action: keyof typeof ALLOWED_TRANSITIONS, current: string): void {
  const allowed = ALLOWED_TRANSITIONS[action] ?? [];
  const state = toClientState(current);
  if (!allowed.includes(state)) {
    throw conflict(`Cannot ${action} a server that is ${state}.`);
  }
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

export interface NodeCapacity {
  cpuTotal: number;
  cpuAllocated: number;
  cpuAvailable: number;
  memoryMibTotal: number;
  memoryMibAllocated: number;
  memoryMibAvailable: number;
  storageGibTotal: number;
  storageGibAllocated: number;
  storageGibAvailable: number;
}

export async function getNodeCapacity(nodeId: string): Promise<NodeCapacity> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('Node not found.');

  const allocated = await prisma.server.aggregate({
    where: { nodeId, deletedAt: null },
    _sum: { cpuCores: true, memoryMib: true, storageGib: true },
  });

  const cpuTotal = node.totalCpuThreads * node.cpuOvercommit;
  const memoryMibTotal = node.totalMemoryMib * node.memoryOvercommit;
  const storageGibTotal = node.totalStorageGib;

  const cpuAllocated = allocated._sum.cpuCores ?? 0;
  const memoryMibAllocated = allocated._sum.memoryMib ?? 0;
  const storageGibAllocated = allocated._sum.storageGib ?? 0;

  return {
    cpuTotal,
    cpuAllocated,
    cpuAvailable: Math.max(0, cpuTotal - cpuAllocated),
    memoryMibTotal,
    memoryMibAllocated,
    memoryMibAvailable: Math.max(0, memoryMibTotal - memoryMibAllocated),
    storageGibTotal,
    storageGibAllocated,
    storageGibAvailable: Math.max(0, storageGibTotal - storageGibAllocated),
  };
}

/**
 * Refuses an allocation the node cannot honour.
 *
 * The marketing copy promises no overselling, and this is where that promise
 * is actually kept.
 */
async function assertCapacity(
  nodeId: string,
  request: { cpuCores: number; memoryMib: number; storageGib: number },
  excludeServerId?: string,
): Promise<void> {
  const capacity = await getNodeCapacity(nodeId);

  let { cpuAvailable, memoryMibAvailable, storageGibAvailable } = capacity;

  if (excludeServerId) {
    const existing = await prisma.server.findUnique({
      where: { id: excludeServerId },
      select: { cpuCores: true, memoryMib: true, storageGib: true },
    });
    if (existing) {
      cpuAvailable += existing.cpuCores;
      memoryMibAvailable += existing.memoryMib;
      storageGibAvailable += existing.storageGib;
    }
  }

  const shortfalls: string[] = [];
  if (request.cpuCores > cpuAvailable) {
    shortfalls.push(`CPU (need ${request.cpuCores}, ${cpuAvailable.toFixed(1)} free)`);
  }
  if (request.memoryMib > memoryMibAvailable) {
    shortfalls.push(
      `memory (need ${(request.memoryMib / 1024).toFixed(0)} GB, ${(memoryMibAvailable / 1024).toFixed(1)} GB free)`,
    );
  }
  if (request.storageGib > storageGibAvailable) {
    shortfalls.push(`storage (need ${request.storageGib} GB, ${storageGibAvailable} GB free)`);
  }

  if (shortfalls.length > 0) {
    throw preconditionFailed(
      `This node does not have enough free capacity: ${shortfalls.join(', ')}.`,
      'insufficient_capacity',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export async function createServer(
  input: CreateServerInput,
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string },
): Promise<Server> {
  await assertHostRequirementsMet();

  const game = GAMES[input.game];
  if (!game.released) {
    throw preconditionFailed(`${game.name} has not been released yet.`, 'game_unavailable');
  }

  const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
  if (!node) throw notFound('Node not found.');
  if (node.status !== 'ONLINE') {
    throw preconditionFailed('That node is not accepting new servers right now.', 'node_unavailable');
  }
  if (!node.requirementsPass) {
    throw preconditionFailed(
      'That node does not currently meet the minimum host requirements.',
      'host_requirements_not_met',
    );
  }

  // Per-game floors sit on top of the platform-wide ones.
  if (input.resources.memoryMib < game.memoryMib.min) {
    throw preconditionFailed(
      `${game.name} requires at least ${game.memoryMib.min / 1024} GB of RAM.`,
      'insufficient_memory',
    );
  }
  if (input.resources.slots > game.maxSlots) {
    throw preconditionFailed(`${game.name} supports at most ${game.maxSlots} slots.`, 'too_many_slots');
  }

  await assertCapacity(input.nodeId, input.resources);

  const config = loadConfig();
  const serverId = generateServerId();
  const containerName = containerNameFor(serverId);
  const volumePath = path.join(node.dataRoot, serverId);

  // RCON and admin passwords are generated, never chosen by the user, and are
  // stored encrypted.
  const secrets = {
    rconPassword: generateToken(24),
    adminPassword: generateToken(24),
    battleyeRconPassword: generateToken(24),
  };

  const ports = await allocatePorts({
    nodeId: node.id,
    gameId: input.game,
    serverId,
  });

  // From here on the allocation is committed. If anything below fails, those
  // rows would sit with serverId null forever - releasePorts only matches on
  // serverId - and the node would slowly run out of ports.
  let server;
  try {
    server = await prisma.server.create({
      data: {
        id: serverId,
        name: input.name,
        game: GAME_TITLE_BY_ID[input.game],
        state: 'CREATING',
        ownerId: actor.accountId,
        nodeId: node.id,
        containerName,
        volumePath,
        cpuCores: input.resources.cpuCores,
        cpuSet: input.resources.cpuSet,
        memoryMib: input.resources.memoryMib,
        storageGib: input.resources.storageGib,
        bandwidthMbps: input.resources.bandwidthMbps,
        transferQuotaGib: input.resources.transferQuotaGib,
        slots: input.resources.slots,
        basePort: ports.basePort,
        publicHost:
          node.relayEnabled && input.useRelay ? node.relayEndpoint ?? node.publicHost : node.publicHost,
        publicBasePort: ports.basePort,
        useRelay: input.useRelay && node.relayEnabled,
        autoPortForward: input.autoPortForward,
        config: getAdapter(input.game).defaultConfig({
          name: input.name,
          slots: input.resources.slots,
        }) as unknown as Prisma.InputJsonValue,
        secretsEnc: encryptSecret(JSON.stringify(secrets), 'server-secrets'),
        members: {
          create: { accountId: actor.accountId, role: 'OWNER' },
        },
      },
    });

    await prisma.portAllocation.updateMany({
      where: { id: { in: ports.allocationIds } },
      data: { serverId: server.id },
    });

    await mkdir(volumePath, { recursive: true, mode: 0o750 });
  } catch (error) {
    // Hand the ports back before rethrowing, so a failed create does not
    // permanently consume a block from the node's range.
    await prisma.portAllocation
      .deleteMany({ where: { id: { in: ports.allocationIds } } })
      .catch(() => undefined);

    logger.error({ err: error, serverId }, 'Server creation failed; released its port block');
    throw error;
  }

  await audit({
    accountId: actor.accountId,
    actorLabel: actor.username,
    action: AuditAction.ServerCreated,
    targetType: 'server',
    targetId: server.id,
    ipHash: actor.ipHash,
    userAgentHash: actor.userAgentHash,
    metadata: {
      game: input.game,
      cpuCores: input.resources.cpuCores,
      memoryMib: input.resources.memoryMib,
      storageGib: input.resources.storageGib,
      slots: input.resources.slots,
      node: node.name,
    },
  });

  logger.info({ serverId: server.id, game: input.game }, 'Server record created');

  // Installation runs in the background; the UI follows it on the console.
  void provisionServer(server.id).catch((error) => {
    logger.error({ err: error, serverId: server.id }, 'Provisioning failed');
  });

  return server;
}

function generateServerId(): string {
  // cuid-shaped, generated here so the container name and volume path can be
  // derived before the row exists.
  return `c${Date.now().toString(36)}${generateToken(12).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
}

/* ------------------------------------------------------------------ */
/* Provisioning                                                        */
/* ------------------------------------------------------------------ */

export async function provisionServer(serverId: string): Promise<void> {
  const server = await loadServer(serverId);
  const gameId = toGameId(server.game);
  const adapter = getAdapter(gameId);

  await setState(serverId, 'INSTALLING');
  emitPanelNotice(serverId, `Provisioning ${GAMES[gameId].name} server...`);

  try {
    // Built on first use rather than at install time - these images are large
    // and there is no reason to build Arma 3's for someone running Reforger.
    await ensureGameImage(gameId, (line) => emitPanelNotice(serverId, line));

    const allocations = await prisma.portAllocation.findMany({ where: { serverId } });

    await createContainer({
      containerName: server.containerName,
      gameId,
      image: GAMES[gameId].image,
      volumePath: server.volumePath,
      basePort: server.basePort,
      publishPorts: allocations.map((a) => ({
        key: a.portKey,
        hostPort: a.externalPort,
        containerPort: a.internalPort,
        protocol: a.protocol as 'udp' | 'tcp',
      })),
      resources: {
        cpuCores: server.cpuCores,
        cpuSet: server.cpuSet,
        memoryMib: server.memoryMib,
        storageGib: server.storageGib,
        bandwidthMbps: server.bandwidthMbps,
      },
      env: adapter.buildEnv(server),
      serverId: server.id,
      ownerId: server.ownerId,
    });

    await adapter.writeConfig(server);

    await prisma.server.update({
      where: { id: serverId },
      data: { lastInstallAt: new Date() },
    });

    await setState(serverId, 'OFFLINE');
    emitPanelNotice(serverId, 'Provisioning complete. The server is ready to start.');
  } catch (error) {
    logger.error({ err: error, serverId }, 'Provisioning failed');
    emitPanelNotice(
      serverId,
      `Provisioning failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    await setState(serverId, 'CRASHED');
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Power actions                                                       */
/* ------------------------------------------------------------------ */

export type PowerActionName = 'start' | 'stop' | 'restart' | 'kill' | 'reinstall';

export async function performPowerAction(
  serverId: string,
  action: PowerActionName,
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string },
): Promise<{ state: ServerState }> {
  const server = await loadServer(serverId);

  if (server.suspended && action !== 'stop' && action !== 'kill') {
    throw preconditionFailed(
      server.suspendReason
        ? `This server is suspended: ${server.suspendReason}`
        : 'This server is suspended.',
      'server_suspended',
    );
  }

  assertTransition(action, server.state);

  const gameId = toGameId(server.game);
  const adapter = getAdapter(gameId);

  await audit({
    accountId: actor.accountId,
    actorLabel: actor.username,
    action: action === 'reinstall' ? AuditAction.ServerReinstalled : AuditAction.ServerPower,
    targetType: 'server',
    targetId: serverId,
    ipHash: actor.ipHash,
    userAgentHash: actor.userAgentHash,
    metadata: { action, fromState: toClientState(server.state) },
  });

  switch (action) {
    case 'start': {
      await setState(serverId, 'STARTING');
      emitPanelNotice(serverId, `Start requested by ${actor.username}.`);
      // Rewrite config on every start so panel changes always take effect.
      await adapter.writeConfig(server);
      await startContainer(server.containerName);
      await prisma.server.update({
        where: { id: serverId },
        data: { lastStartedAt: new Date(), crashCount: 0 },
      });
      return { state: 'starting' };
    }

    case 'stop': {
      await setState(serverId, 'STOPPING');
      emitPanelNotice(serverId, `Stop requested by ${actor.username}.`);
      await stopContainer(server.containerName, 30);
      await setState(serverId, 'OFFLINE');
      await prisma.server.update({
        where: { id: serverId },
        data: { lastStoppedAt: new Date(), playersOnline: 0 },
      });
      return { state: 'offline' };
    }

    case 'restart': {
      await setState(serverId, 'RESTARTING');
      emitPanelNotice(serverId, `Restart requested by ${actor.username}.`);
      await adapter.writeConfig(server);
      await restartContainer(server.containerName, 30);
      await setState(serverId, 'STARTING');
      return { state: 'starting' };
    }

    case 'kill': {
      emitPanelNotice(serverId, `Force kill requested by ${actor.username}. State may not be saved.`);
      await killContainer(server.containerName);
      await setState(serverId, 'OFFLINE');
      await prisma.server.update({
        where: { id: serverId },
        data: { lastStoppedAt: new Date(), playersOnline: 0 },
      });
      return { state: 'offline' };
    }

    case 'reinstall': {
      await setState(serverId, 'REINSTALLING');
      emitPanelNotice(
        serverId,
        `Reinstall requested by ${actor.username}. Game files will be replaced; the config and mod list are kept.`,
      );
      void reinstallServer(serverId).catch((error) => {
        logger.error({ err: error, serverId }, 'Reinstall failed');
      });
      return { state: 'reinstalling' };
    }

    default: {
      throw new AppError(400, 'unknown_action', 'Unknown power action.');
    }
  }
}

async function reinstallServer(serverId: string): Promise<void> {
  const server = await loadServer(serverId);
  const gameId = toGameId(server.game);

  try {
    await stopContainer(server.containerName, 30).catch(() => undefined);
    await removeContainer(server.containerName, { force: true }).catch(() => undefined);

    // Game files are replaced; the config, mods and saves directories survive.
    emitPanelNotice(serverId, 'Removing installed game files...');
    const gameFilesPath = path.join(server.volumePath, 'gamefiles');
    await rm(gameFilesPath, { recursive: true, force: true }).catch(() => undefined);

    emitPanelNotice(serverId, 'Reinstalling...');
    await provisionServer(serverId);
    emitPanelNotice(serverId, 'Reinstall complete.');
  } catch (error) {
    emitPanelNotice(
      serverId,
      `Reinstall failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    await setState(serverId, 'CRASHED');
    logger.error({ err: error, serverId, gameId }, 'Reinstall failed');
  }
}

/* ------------------------------------------------------------------ */
/* Resource changes                                                    */
/* ------------------------------------------------------------------ */

export async function updateResources(
  serverId: string,
  resources: {
    cpuCores: number;
    cpuSet: string | null;
    memoryMib: number;
    storageGib: number;
    bandwidthMbps: number;
    transferQuotaGib: number;
    slots: number;
  },
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string },
): Promise<Server> {
  const server = await loadServer(serverId);
  const game = GAMES[toGameId(server.game)];

  if (resources.memoryMib < Math.max(RESOURCE_LIMITS.memoryMib.min, game.memoryMib.min)) {
    throw preconditionFailed(
      `${game.name} requires at least ${Math.max(RESOURCE_LIMITS.memoryMib.min, game.memoryMib.min) / 1024} GB of RAM.`,
      'insufficient_memory',
    );
  }
  if (resources.slots > game.maxSlots) {
    throw preconditionFailed(`${game.name} supports at most ${game.maxSlots} slots.`, 'too_many_slots');
  }

  await assertCapacity(server.nodeId, resources, serverId);

  const updated = await prisma.server.update({
    where: { id: serverId },
    data: resources,
  });

  await audit({
    accountId: actor.accountId,
    actorLabel: actor.username,
    action: AuditAction.ServerResourcesChanged,
    targetType: 'server',
    targetId: serverId,
    ipHash: actor.ipHash,
    userAgentHash: actor.userAgentHash,
    metadata: {
      before: {
        cpuCores: server.cpuCores,
        memoryMib: server.memoryMib,
        storageGib: server.storageGib,
        slots: server.slots,
      },
      after: resources,
    },
  });

  emitPanelNotice(
    serverId,
    'Resource limits updated. Restart the server for CPU and memory changes to take effect.',
  );

  return updated;
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

export async function deleteServer(
  serverId: string,
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string },
  options: { purgeData: boolean },
): Promise<void> {
  const server = await loadServer(serverId);

  await setState(serverId, 'DELETING');

  await stopContainer(server.containerName, 15).catch(() => undefined);
  await removeContainer(server.containerName, { force: true }).catch(() => undefined);
  await releasePorts(serverId).catch((error) => {
    logger.warn({ err: error, serverId }, 'Failed to release port mappings');
  });

  if (options.purgeData) {
    // Confined by construction: volumePath is built from the node's dataRoot
    // and a generated id, never from user input.
    const resolved = path.resolve(server.volumePath);
    const root = path.resolve((await prisma.node.findUnique({ where: { id: server.nodeId } }))!.dataRoot);
    if (resolved.startsWith(root + path.sep)) {
      await rm(resolved, { recursive: true, force: true }).catch((error) => {
        logger.error({ err: error, serverId }, 'Failed to remove server volume');
      });
    } else {
      logger.error({ serverId, resolved, root }, 'Refusing to delete a path outside the node data root');
    }
  }

  await prisma.server.update({
    where: { id: serverId },
    data: { deletedAt: new Date(), state: 'OFFLINE', containerId: null },
  });

  dropConsole(serverId);

  await audit({
    accountId: actor.accountId,
    actorLabel: actor.username,
    action: AuditAction.ServerDeleted,
    targetType: 'server',
    targetId: serverId,
    ipHash: actor.ipHash,
    userAgentHash: actor.userAgentHash,
    metadata: { purgedData: options.purgeData, name: server.name },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export async function loadServer(serverId: string): Promise<Server> {
  const server = await prisma.server.findFirst({ where: { id: serverId, deletedAt: null } });
  if (!server) throw notFound('Server not found.');
  return server;
}

export async function setState(serverId: string, state: Server['state']): Promise<void> {
  await prisma.server.update({ where: { id: serverId }, data: { state } });
}

/** Reconciles the database against what Docker actually reports. */
export async function syncServerState(serverId: string): Promise<ServerState> {
  const server = await loadServer(serverId);
  const status = await inspectContainer(server.containerName);

  let next: Server['state'];
  if (!status.exists) {
    next = 'CREATING';
  } else if (status.running) {
    next = 'RUNNING';
  } else if (status.exitCode !== null && status.exitCode !== 0) {
    next = 'CRASHED';
  } else {
    next = 'OFFLINE';
  }

  // Do not stomp on a transition that is legitimately in progress.
  const transient: Server['state'][] = ['CREATING', 'INSTALLING', 'REINSTALLING', 'DELETING'];
  if (transient.includes(server.state)) return toClientState(server.state);

  if (server.state !== next) {
    await setState(serverId, next);
  }
  return toClientState(next);
}

export { CONTAINER_DATA_PATH };
