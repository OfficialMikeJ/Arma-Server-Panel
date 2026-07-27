/**
 * Game server routes.
 *
 * Authorisation pattern used throughout: `resolveServerAccess` establishes what
 * the caller may do (owner, member role, platform admin, or a scoped API key),
 * then `assertPermission` gates the specific action. A caller with no access
 * gets 404, not 403, so server ids cannot be probed.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GAMES,
  RATE_LIMITS,
  createServerSchema,
  cuidSchema,
  paginationSchema,
  powerActionSchema,
  resourceAllocationSchema,
  updateServerSchema,
  ROLE_PERMISSIONS,
  type GameId,
  type Permission,
} from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess, type ServerAccess } from '../plugins/auth.js';
import { buildKey, consumeRateLimit } from '../security/rate-limit.js';
import { audit, AuditAction } from '../security/audit.js';
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.js';
import {
  createServer,
  deleteServer,
  getNodeCapacity,
  loadServer,
  performPowerAction,
  syncServerState,
  toGameId,
  updateResources,
} from '../modules/servers/server-service.js';
import { getAdapter } from '../modules/games/registry.js';
import { getServerPorts } from '../modules/network/port-allocator.js';
import { directorySize } from '../modules/files/file-service.js';

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /* -------------------------------------------------------------- */
  /* List / create                                                   */
  /* -------------------------------------------------------------- */

  app.get('/servers', guard, async (request, reply) => {
    const account = request.auth.account!;
    const query = paginationSchema.parse(request.query ?? {});

    const isPlatformAdmin = account.type === 'ADMIN' || account.isPlatformOwner;

    const servers = await prisma.server.findMany({
      where: {
        deletedAt: null,
        ...(isPlatformAdmin
          ? {}
          : {
              OR: [{ ownerId: account.id }, { members: { some: { accountId: account.id } } }],
            }),
        ...(request.auth.apiKeyServerIds.length > 0
          ? { id: { in: request.auth.apiKeyServerIds } }
          : {}),
      },
      include: { node: { select: { locationLabel: true, region: true } } },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    return reply.send({
      servers: servers.map(serialiseServer),
      nextCursor: servers.length === query.limit ? servers.at(-1)?.id ?? null : null,
    });
  });

  app.post('/servers', guard, async (request, reply) => {
    const account = request.auth.account!;
    const body = createServerSchema.parse(request.body);

    const limit = await consumeRateLimit(buildKey('server-create', account.id), {
      points: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      throw tooManyRequests('You have created too many servers recently.', limit.resetMs / 1000);
    }

    const server = await createServer(body, {
      accountId: account.id,
      username: account.username,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.status(201).send({ server: serialiseServer(server) });
  });

  /* -------------------------------------------------------------- */
  /* Single server                                                   */
  /* -------------------------------------------------------------- */

  app.get('/servers/:id', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const server = await prisma.server.findFirst({
      where: { id, deletedAt: null },
      include: {
        node: { select: { id: true, name: true, locationLabel: true, region: true } },
        owner: { select: { id: true, username: true } },
        _count: { select: { members: true, mods: true } },
      },
    });
    if (!server) throw notFound('Server not found.');

    // Reconcile with the container runtime so the UI never shows a stale state.
    const state = await syncServerState(id).catch(() => undefined);
    const ports = await getServerPorts(id);

    return reply.send({
      server: {
        ...serialiseServer(server),
        ...(state ? { state } : {}),
        description: server.description,
        // Filled out with the game's own defaults before it leaves. A config
        // stored before a setting existed has no value for it, and the settings
        // form would then show an unticked box for something the server is in
        // fact doing - the schema default is what actually applies at start.
        config: normaliseConfig(toGameId(server.game), server.config),
        autoStart: server.autoStart,
        autoRestart: server.autoRestart,
        crashRestartLimit: server.crashRestartLimit,
        crashCount: server.crashCount,
        installedVersion: server.installedVersion,
        lastInstallAt: server.lastInstallAt?.toISOString() ?? null,
        owner: server.owner,
        counts: { members: server._count.members, mods: server._count.mods },
        ports: ports.map((port) => ({
          key: port.portKey,
          protocol: port.protocol,
          internal: port.internalPort,
          external: port.externalPort,
          method: port.method.toLowerCase(),
          active: port.active,
          reachable: port.reachable,
          message: port.message,
          // RCON ports are never published; make that explicit in the UI.
          public:
            GAMES[toGameId(server.game)].ports.find((p) => p.key === port.portKey)?.public ?? false,
        })),
      },
      permissions: [...access.permissions],
      role: access.role,
    });
  });

  app.patch('/servers/:id', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:settings');

    const body = updateServerSchema.parse(request.body);
    const updated = await prisma.server.update({ where: { id }, data: body });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.ServerUpdated,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { fields: Object.keys(body) },
    });

    return reply.send({ server: serialiseServer(updated) });
  });

  /* -------------------------------------------------------------- */
  /* Game configuration                                              */
  /* -------------------------------------------------------------- */

  app.patch('/servers/:id/config', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:settings');

    const server = await loadServer(id);
    const adapter = getAdapter(toGameId(server.game));

    // The adapter validates against the game's own schema and throws with
    // field-level detail if anything is out of range.
    const config = adapter.validateConfig(request.body, server.config as Record<string, unknown>);

    const updated = await prisma.server.update({
      where: { id },
      data: { config: config as never },
    });

    // Write it out now so a restart is the only thing needed to apply it.
    await adapter.writeConfig(updated).catch(() => undefined);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.ServerUpdated,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { scope: 'game_config' },
    });

    return reply.send({ config });
  });

  /* -------------------------------------------------------------- */
  /* Resources                                                       */
  /* -------------------------------------------------------------- */

  app.patch('/servers/:id/resources', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:resources');

    const resources = resourceAllocationSchema.parse(request.body);
    const updated = await updateResources(id, resources, {
      accountId: request.auth.account!.id,
      username: request.auth.account!.username,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ server: serialiseServer(updated) });
  });

  app.get('/servers/:id/usage', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const server = await loadServer(id);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [usage, diskBytes] = await Promise.all([
      prisma.bandwidthUsage.findUnique({
        where: { serverId_periodStart: { serverId: id, periodStart } },
      }),
      directorySize(server.volumePath).catch(() => 0),
    ]);

    const rx = Number(usage?.rxBytes ?? 0n);
    const tx = Number(usage?.txBytes ?? 0n);

    return reply.send({
      period: { start: periodStart.toISOString() },
      bandwidth: {
        rxBytes: rx,
        txBytes: tx,
        totalBytes: rx + tx,
        quotaGib: server.transferQuotaGib,
        percentUsed:
          server.transferQuotaGib > 0
            ? Math.min(100, ((rx + tx) / 1024 ** 3 / server.transferQuotaGib) * 100)
            : null,
      },
      storage: {
        usedBytes: diskBytes,
        quotaGib: server.storageGib,
        percentUsed: Math.min(100, (diskBytes / 1024 ** 3 / server.storageGib) * 100),
      },
    });
  });

  /* -------------------------------------------------------------- */
  /* Power                                                           */
  /* -------------------------------------------------------------- */

  app.post('/servers/:id/power', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    const body = powerActionSchema.parse(request.body);

    if (body.action === 'reinstall') {
      assertPermission(access, 'server:reinstall');

      // Reinstall replaces game files. Require the operator to type the server
      // name, the same pattern used for repository deletion.
      const server = await loadServer(id);
      if (body.confirmation !== server.name) {
        throw badRequest('Type the server name exactly to confirm a reinstall.');
      }

      const limit = await consumeRateLimit(buildKey('reinstall', id), RATE_LIMITS.reinstall);
      if (!limit.allowed) {
        throw tooManyRequests('This server has been reinstalled too many times recently.', limit.resetMs / 1000);
      }
    } else {
      assertPermission(access, 'server:power');

      const limit = await consumeRateLimit(buildKey('power', id), RATE_LIMITS.serverPower);
      if (!limit.allowed) {
        throw tooManyRequests('Too many power actions for this server.', limit.resetMs / 1000);
      }
    }

    const result = await performPowerAction(id, body.action, {
      accountId: request.auth.account!.id,
      username: request.auth.account!.username,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send(result);
  });

  /* -------------------------------------------------------------- */
  /* Members                                                         */
  /* -------------------------------------------------------------- */

  app.get('/servers/:id/members', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:members');

    const members = await prisma.serverMember.findMany({
      where: { serverId: id },
      include: {
        account: {
          select: { id: true, username: true, discordId: true, discordUsername: true, discordAvatar: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      // What the caller holds, so the UI can grey out anything they are not in
      // a position to hand over.
      grantable: [...access.permissions],
      members: members.map((member) => ({
        id: member.id,
        role: member.role.toLowerCase(),
        // Both shapes: the explicit override as stored, and what the member can
        // actually do. An empty override means "use the role default", so
        // showing only the raw column would render every default member as
        // having no permissions at all.
        permissions: member.permissions,
        effectivePermissions:
          member.permissions.length > 0
            ? member.permissions
            : [...ROLE_PERMISSIONS[roleKeyFor(member.role)]],
        createdAt: member.createdAt.toISOString(),
        account: {
          id: member.account.id,
          username: member.account.username,
          discord: member.account.discordId
            ? {
                id: member.account.discordId,
                username: member.account.discordUsername,
                avatar: member.account.discordAvatar,
              }
            : null,
        },
      })),
    });
  });

  app.post('/servers/:id/members', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:members');

    const { addMemberSchema, canonicalizeUsername } = await import('@asp/shared');
    const body = addMemberSchema.parse(request.body);

    // "Add anyone's Discord User ID in the Users area so they can log in with
    // Discord to manage the server" - matches the reference panel's behaviour.
    const target =
      body.identifierType === 'discord_id'
        ? await prisma.account.findFirst({ where: { discordId: body.identifier, deletedAt: null } })
        : await prisma.account.findFirst({
            where: { canonicalUsername: canonicalizeUsername(body.identifier), deletedAt: null },
          });

    if (!target) {
      throw notFound(
        body.identifierType === 'discord_id'
          ? 'No panel account is linked to that Discord ID yet. Ask them to sign in with Discord once first.'
          : 'No account with that username.',
      );
    }

    const server = await loadServer(id);
    if (target.id === server.ownerId) throw badRequest('That account already owns this server.');
    if (target.id === request.auth.account!.id) {
      throw forbidden('You cannot change your own membership of this server.');
    }

    const role = body.role.toUpperCase() as 'ADMIN' | 'OPERATOR' | 'VIEWER';
    assertCanDelegate(access, role, body.permissionOverrides);

    const member = await prisma.serverMember.upsert({
      where: { serverId_accountId: { serverId: id, accountId: target.id } },
      create: {
        serverId: id,
        accountId: target.id,
        role,
        permissions: body.permissionOverrides ?? [],
        invitedById: request.auth.account!.id,
      },
      update: { role, permissions: body.permissionOverrides ?? [] },
    });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.MemberAdded,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { member: target.username, role },
    });

    return reply.status(201).send({ member: { id: member.id, role: member.role.toLowerCase() } });
  });

  /**
   * Edits one member's permissions.
   *
   * Split from the add route so a sub-user's access can be tuned without
   * re-stating who they are, and so the UI has somewhere to send a single
   * checkbox change.
   */
  app.patch('/servers/:id/members/:memberId', guard, async (request, reply) => {
    const { id, memberId } = z
      .object({ id: cuidSchema, memberId: cuidSchema })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:members');

    const { PERMISSIONS } = await import('@asp/shared');
    const body = z
      .object({
        role: z.enum(['admin', 'operator', 'viewer']).optional(),
        permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
      })
      .parse(request.body ?? {});

    const member = await prisma.serverMember.findFirst({
      where: { id: memberId, serverId: id },
      include: { account: { select: { id: true, username: true } } },
    });
    if (!member) throw notFound('Member not found.');
    if (member.role === 'OWNER') throw forbidden('The owner’s access cannot be edited.');
    if (member.account.id === request.auth.account!.id) {
      throw forbidden('You cannot change your own permissions. Request a change instead.');
    }

    const role = (body.role?.toUpperCase() ?? member.role) as 'ADMIN' | 'OPERATOR' | 'VIEWER';
    assertCanDelegate(access, role, body.permissions);

    const updated = await prisma.serverMember.update({
      where: { id: memberId },
      data: {
        ...(body.role ? { role } : {}),
        ...(body.permissions ? { permissions: body.permissions } : {}),
      },
      select: { id: true, role: true, permissions: true },
    });

    // The change applies on their next request, not their next sign-in.
    const { revokeAllSessions } = await import('../security/session.js');
    await revokeAllSessions(member.account.id, 'permissions_changed');

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.MemberPermissionsChanged,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { member: member.account.username, role, permissions: body.permissions },
    });

    return reply.send({
      member: {
        id: updated.id,
        role: updated.role.toLowerCase(),
        permissions: updated.permissions,
      },
    });
  });

  app.delete('/servers/:id/members/:memberId', guard, async (request, reply) => {
    const { id, memberId } = z
      .object({ id: cuidSchema, memberId: cuidSchema })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:members');

    const member = await prisma.serverMember.findFirst({
      where: { id: memberId, serverId: id },
      include: { account: { select: { username: true } } },
    });
    if (!member) throw notFound('Member not found.');
    if (member.role === 'OWNER') throw forbidden('The owner cannot be removed.');

    await prisma.serverMember.delete({ where: { id: memberId } });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.MemberRemoved,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { member: member.account.username },
    });

    return reply.send({ ok: true });
  });

  /* -------------------------------------------------------------- */
  /* Events + delete                                                 */
  /* -------------------------------------------------------------- */

  app.get('/servers/:id/events', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const query = paginationSchema.parse(request.query ?? {});
    const events = await prisma.serverEvent.findMany({
      where: { serverId: id },
      orderBy: { at: 'desc' },
      take: query.limit,
    });

    return reply.send({
      events: events.map((event) => ({
        id: event.id.toString(),
        at: event.at.toISOString(),
        kind: event.kind,
        message: event.message,
        data: event.data,
      })),
    });
  });

  app.delete('/servers/:id', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:delete');

    const body = z
      .object({ confirmation: z.string().max(64), purgeData: z.boolean().default(true) })
      .parse(request.body ?? {});

    const server = await loadServer(id);
    if (body.confirmation !== server.name) {
      throw badRequest('Type the server name exactly to confirm deletion.');
    }

    await deleteServer(
      id,
      {
        accountId: request.auth.account!.id,
        username: request.auth.account!.username,
        ipHash: request.auth.client.ipHash,
        userAgentHash: request.auth.client.userAgentHash,
      },
      { purgeData: body.purgeData },
    );

    return reply.send({ ok: true });
  });

  /* -------------------------------------------------------------- */
  /* Capacity, for the create form                                   */
  /* -------------------------------------------------------------- */

  app.get('/nodes/:nodeId/capacity', guard, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: cuidSchema }).parse(request.params);
    const capacity = await getNodeCapacity(nodeId);
    return reply.send({ capacity });
  });
}

/* ------------------------------------------------------------------ */
/** Maps the stored enum to the shared role vocabulary. */
function roleKeyFor(role: string): 'owner' | 'admin' | 'operator' | 'viewer' {
  switch (role) {
    case 'OWNER':
      return 'owner';
    case 'ADMIN':
      return 'admin';
    case 'OPERATOR':
      return 'operator';
    default:
      return 'viewer';
  }
}

/**
 * Nobody delegates access they do not hold.
 *
 * Without this, `server:members` alone would be enough to mint a membership
 * with every permission on the server and use it, which makes the role
 * distinction decorative. The server owner holds everything, so this never
 * stands in their way - it constrains a delegated administrator handing out
 * more than they were given.
 */
function assertCanDelegate(
  access: ServerAccess,
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER',
  overrides: readonly Permission[] | undefined,
): void {
  const roleKey = role.toLowerCase() as 'admin' | 'operator' | 'viewer';
  const effective = overrides && overrides.length > 0 ? overrides : ROLE_PERMISSIONS[roleKey];

  const excess = effective.filter((permission) => !access.permissions.has(permission));
  if (excess.length > 0) {
    throw forbidden(
      `You cannot grant permissions you do not hold yourself: ${excess.join(', ')}.`,
    );
  }
}

/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Applies the game's schema defaults to a stored config.
 *
 * Returns it untouched if the schema rejects it, so a config that has somehow
 * drifted out of spec is still visible and repairable in the editor rather than
 * turning the whole settings page into an error.
 */
function normaliseConfig(gameId: GameId, config: unknown): unknown {
  try {
    return getAdapter(gameId).validateConfig({}, config as Record<string, unknown>);
  } catch {
    return config;
  }
}

function serialiseServer(server: {
  id: string;
  name: string;
  game: string;
  state: string;
  nodeId: string;
  slots: number;
  playersOnline: number;
  publicHost: string;
  publicBasePort: number;
  suspended: boolean;
  suspendReason: string | null;
  cpuCores: number;
  memoryMib: number;
  storageGib: number;
  bandwidthMbps: number;
  transferQuotaGib: number;
  useRelay: boolean;
  createdAt: Date;
  node?: { locationLabel: string; region: string } | null;
}) {
  return {
    id: server.id,
    name: server.name,
    game: toGameId(server.game),
    state: server.state.toLowerCase(),
    nodeId: server.nodeId,
    region: server.node?.region ?? '',
    location: server.node?.locationLabel ?? '',
    slots: server.slots,
    playersOnline: server.playersOnline,
    address: `${server.publicHost}:${server.publicBasePort}`,
    suspended: server.suspended,
    suspendReason: server.suspendReason,
    resources: {
      cpuCores: server.cpuCores,
      memoryMib: server.memoryMib,
      storageGib: server.storageGib,
      bandwidthMbps: server.bandwidthMbps,
      transferQuotaGib: server.transferQuotaGib,
      slots: server.slots,
    },
    useRelay: server.useRelay,
    createdAt: server.createdAt.toISOString(),
  };
}
