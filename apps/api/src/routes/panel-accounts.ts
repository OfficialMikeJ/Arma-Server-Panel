/**
 * Sub-admin accounts and access requests.
 *
 * Two related ideas:
 *
 *   * A sub-admin administers the *panel* and nothing else. Where a full ADMIN
 *     is granted implicit admin on every server, a SUB_ADMIN is granted exactly
 *     the `panel:*` permissions listed on their account and no server access at
 *     all. To touch a game server they must be added to it as a member, like
 *     anyone else. That separation is the whole feature - see
 *     packages/shared/src/panel-permissions.ts.
 *
 *   * Nobody widens their own access. A sub-user or sub-admin who needs more
 *     asks, an administrator decides, and the record of both survives the
 *     decision. The request never grants anything by itself.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PANEL_PERMISSIONS,
  PERMISSIONS,
  panelPermissionsFor,
  cuidSchema,
  usernameSchema,
  type PanelPermission,
  type Permission,
} from '@asp/shared';
import { prisma } from '../db/client.js';
import { audit, AuditAction } from '../security/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../security/password.js';
import { resolveServerAccess } from '../plugins/auth.js';
import { generateToken } from '../security/crypto.js';
import { canonicalizeUsername } from '@asp/shared';

const panelPermissionSchema = z.enum(PANEL_PERMISSIONS);
const serverPermissionSchema = z.enum(PERMISSIONS);

const createSubAdminSchema = z.object({
  username: usernameSchema,
  /** Empty grants nothing, which is a valid and deliberately dull starting point. */
  panelPermissions: z.array(panelPermissionSchema).max(PANEL_PERMISSIONS.length).default([]),
});

const updateSubAdminSchema = z.object({
  panelPermissions: z.array(panelPermissionSchema).max(PANEL_PERMISSIONS.length).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
});

const createRequestSchema = z.object({
  /** Omitted for a panel-scoped request. */
  serverId: cuidSchema.optional(),
  requested: z.array(z.string().min(1).max(64)).min(1).max(32),
  reason: z.string().trim().min(10).max(1000),
});

const decideRequestSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
  /**
   * Lets the decider approve a subset. Omitted approves exactly what was asked
   * for - the common case, but granting less than requested should not force a
   * denial and a second round trip.
   */
  grant: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export async function registerPanelAccountRoutes(app: FastifyInstance): Promise<void> {
  const readAccounts = { onRequest: [app.requirePanelPermission('panel:accounts.read')] };
  const writeAccounts = { onRequest: [app.requirePanelPermission('panel:accounts.write')] };
  const reviewRequests = { onRequest: [app.requirePanelPermission('panel:requests.review')] };
  const userGuard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /* ---------------------------------------------------------------- */
  /* Sub-admin accounts                                                */
  /* ---------------------------------------------------------------- */

  app.get('/admin/panel-accounts', readAccounts, async (_request, reply) => {
    const accounts = await prisma.account.findMany({
      where: { type: { in: ['ADMIN', 'SUB_ADMIN'] }, deletedAt: null },
      orderBy: [{ type: 'asc' }, { username: 'asc' }],
      select: {
        id: true,
        username: true,
        type: true,
        status: true,
        isPlatformOwner: true,
        panelPermissions: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return reply.send({
      accounts: accounts.map((account) => ({
        ...account,
        // Resolved rather than raw, so the UI shows what the account can
        // actually do - a full ADMIN's empty column is not "no access".
        effectivePermissions: [...panelPermissionsFor(account)],
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
      })),
      available: PANEL_PERMISSIONS,
    });
  });

  /**
   * Creates a sub-admin.
   *
   * Returns a one-time password which the account must change on first login,
   * and which is shown exactly once. Like every other account it cannot get
   * past the login screen until TOTP is enrolled.
   */
  app.post('/admin/panel-accounts', writeAccounts, async (request, reply) => {
    const body = createSubAdminSchema.parse(request.body);
    const actor = request.auth.account!;

    assertCanGrant(actor, body.panelPermissions);

    const canonical = canonicalizeUsername(body.username);
    const existing = await prisma.account.findFirst({
      where: { OR: [{ canonicalUsername: canonical }, { username: body.username }] },
      select: { id: true },
    });
    if (existing) throw badRequest('That username is already taken.');

    // Long and random: it exists only to get through one login, and the account
    // is forced to change it before anything else is reachable.
    const temporaryPassword = generateToken(18);

    const account = await prisma.account.create({
      data: {
        username: body.username,
        canonicalUsername: canonical,
        type: 'SUB_ADMIN',
        status: 'PENDING_TOTP',
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        panelPermissions: body.panelPermissions,
      },
      select: { id: true, username: true },
    });

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.SubAdminCreated,
      targetType: 'account',
      targetId: account.id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { username: account.username, permissions: body.panelPermissions },
    });

    return reply.status(201).send({
      account,
      temporaryPassword,
      notice:
        'Shown once. The account must change this password and enrol two-factor authentication before it can do anything.',
    });
  });

  app.patch('/admin/panel-accounts/:accountId', writeAccounts, async (request, reply) => {
    const { accountId } = z.object({ accountId: cuidSchema }).parse(request.params);
    const body = updateSubAdminSchema.parse(request.body);
    const actor = request.auth.account!;

    const target = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, username: true, type: true, isPlatformOwner: true },
    });
    if (!target) throw notFound('Account not found.');

    // The panel owner is not administrable from here. Someone has to remain
    // able to fix a mistake made on this screen.
    if (target.isPlatformOwner) throw forbidden('The platform owner cannot be modified here.');
    if (target.type !== 'SUB_ADMIN') {
      throw badRequest('Only sub-admin accounts are managed here.');
    }
    if (target.id === actor.id) {
      throw forbidden('You cannot change your own permissions.');
    }
    if (body.panelPermissions) assertCanGrant(actor, body.panelPermissions);

    await prisma.account.update({
      where: { id: accountId },
      data: {
        ...(body.panelPermissions ? { panelPermissions: body.panelPermissions } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });

    // A narrowed or suspended account must lose its live sessions immediately,
    // or the grant that was just taken away stays usable until they expire.
    const { revokeAllSessions } = await import('../security/session.js');
    await revokeAllSessions(accountId, 'permissions_changed');

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.SubAdminUpdated,
      targetType: 'account',
      targetId: accountId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { username: target.username, ...body },
    });

    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------------- */
  /* Access requests                                                   */
  /* ---------------------------------------------------------------- */

  /** Anyone signed in may ask. Asking grants nothing. */
  app.post('/access-requests', userGuard, async (request, reply) => {
    const body = createRequestSchema.parse(request.body);
    const account = request.auth.account!;

    const requested = body.serverId
      ? parsePermissions(body.requested, serverPermissionSchema, 'server')
      : parsePermissions(body.requested, panelPermissionSchema, 'panel');

    if (body.serverId) {
      // Must already be a member: this widens existing access, it is not a way
      // to discover or ask about servers you have nothing to do with.
      const membership = await prisma.serverMember.findUnique({
        where: { serverId_accountId: { serverId: body.serverId, accountId: account.id } },
        select: { id: true },
      });
      const owns = await prisma.server.findFirst({
        where: { id: body.serverId, ownerId: account.id, deletedAt: null },
        select: { id: true },
      });
      if (!membership && !owns) throw notFound('Server not found.');
    }

    const duplicate = await prisma.accessRequest.findFirst({
      where: { accountId: account.id, serverId: body.serverId ?? null, status: 'PENDING' },
      select: { id: true },
    });
    if (duplicate) {
      throw badRequest('You already have a pending request for this. Wait for it to be decided.');
    }

    const created = await prisma.accessRequest.create({
      data: {
        accountId: account.id,
        serverId: body.serverId ?? null,
        requested,
        reason: body.reason,
      },
      select: { id: true, createdAt: true },
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AccessRequested,
      targetType: body.serverId ? 'server' : 'panel',
      targetId: body.serverId ?? null,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { requested },
    });

    return reply.status(201).send({ request: created });
  });

  /** The caller's own requests, so they can see where one got to. */
  app.get('/access-requests/mine', userGuard, async (request, reply) => {
    const rows = await prisma.accessRequest.findMany({
      where: { accountId: request.auth.account!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { server: { select: { name: true } } },
    });
    return reply.send({ requests: rows.map(serialiseRequest) });
  });

  app.delete('/access-requests/:requestId', userGuard, async (request, reply) => {
    const { requestId } = z.object({ requestId: cuidSchema }).parse(request.params);
    const existing = await prisma.accessRequest.findFirst({
      where: { id: requestId, accountId: request.auth.account!.id },
      select: { id: true, status: true },
    });
    if (!existing) throw notFound('Request not found.');
    if (existing.status !== 'PENDING') throw badRequest('That request has already been decided.');

    await prisma.accessRequest.update({
      where: { id: requestId },
      data: { status: 'WITHDRAWN' },
    });
    return reply.send({ ok: true });
  });

  app.get('/admin/access-requests', reviewRequests, async (request, reply) => {
    const { status } = z
      .object({ status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN']).optional() })
      .parse(request.query ?? {});

    const rows = await prisma.accessRequest.findMany({
      where: status ? { status } : { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        server: { select: { name: true } },
        account: { select: { username: true, type: true } },
      },
    });

    return reply.send({ requests: rows.map(serialiseRequest) });
  });

  /**
   * Decides a request, and applies it.
   *
   * Approval is the only thing that ever widens access, and it goes through the
   * same grant check as editing permissions directly - a reviewer cannot use an
   * approval to hand out something they do not hold themselves.
   */
  app.post('/admin/access-requests/:requestId', reviewRequests, async (request, reply) => {
    const { requestId } = z.object({ requestId: cuidSchema }).parse(request.params);
    const body = decideRequestSchema.parse(request.body);
    const actor = request.auth.account!;

    const existing = await prisma.accessRequest.findUnique({
      where: { id: requestId },
      include: { account: { select: { id: true, username: true, type: true } } },
    });
    if (!existing) throw notFound('Request not found.');
    if (existing.status !== 'PENDING') throw badRequest('That request has already been decided.');
    if (existing.accountId === actor.id) {
      throw forbidden('You cannot decide your own request.');
    }

    if (!body.approve) {
      await prisma.accessRequest.update({
        where: { id: requestId },
        data: {
          status: 'DENIED',
          decidedById: actor.id,
          decidedAt: new Date(),
          decisionNote: body.note ?? null,
        },
      });

      await audit({
        accountId: actor.id,
        actorLabel: actor.username,
        action: AuditAction.AccessRequestDenied,
        targetType: existing.serverId ? 'server' : 'panel',
        targetId: existing.serverId,
        ipHash: request.auth.client.ipHash,
        userAgentHash: request.auth.client.userAgentHash,
        metadata: { requester: existing.account.username, requested: existing.requested },
      });

      return reply.send({ ok: true, granted: [] });
    }

    // Granting a subset is normal; granting something never asked for is not.
    const asked = new Set(existing.requested);
    const grantList = (body.grant ?? existing.requested).filter((p) => asked.has(p));
    if (grantList.length === 0) {
      throw badRequest('Approving with nothing granted. Deny the request instead.');
    }

    if (existing.serverId) {
      // The same rule as everywhere else: you cannot hand on what you do not
      // hold. A full administrator holds admin on every server so this never
      // obstructs them, but `panel:requests.review` on its own must not become
      // a way to grant server access the reviewer has no relationship with.
      const reviewerAccess = await resolveServerAccess(request, existing.serverId);
      const excess = (grantList as Permission[]).filter((p) => !reviewerAccess.permissions.has(p));
      if (excess.length > 0) {
        throw forbidden(
          `You do not hold these on that server, so you cannot grant them: ${excess.join(', ')}.`,
        );
      }

      await applyServerGrant(existing.serverId, existing.accountId, grantList as Permission[]);
    } else {
      assertCanGrant(actor, grantList as PanelPermission[]);
      await applyPanelGrant(existing.accountId, grantList as PanelPermission[]);
    }

    await prisma.accessRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        decidedById: actor.id,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
        requested: grantList,
      },
    });

    // The new grant takes effect on their next request, not their next login.
    const { revokeAllSessions } = await import('../security/session.js');
    await revokeAllSessions(existing.accountId, 'permissions_changed');

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.AccessRequestApproved,
      targetType: existing.serverId ? 'server' : 'panel',
      targetId: existing.serverId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { requester: existing.account.username, granted: grantList },
    });

    return reply.send({ ok: true, granted: grantList });
  });
}

/* ------------------------------------------------------------------ */

/**
 * Nobody hands out what they do not hold.
 *
 * Without this, `panel:accounts.write` alone would be enough to mint an account
 * with every permission and sign in as it - which makes every other panel
 * permission decorative.
 */
function assertCanGrant(
  actor: { type: string; isPlatformOwner: boolean; panelPermissions: string[] },
  requested: readonly PanelPermission[],
): void {
  const held = panelPermissionsFor(actor);
  const excess = requested.filter((permission) => !held.has(permission));
  if (excess.length > 0) {
    throw forbidden(
      `You cannot grant permissions you do not hold yourself: ${excess.join(', ')}.`,
    );
  }
}

function parsePermissions<T extends z.ZodTypeAny>(
  values: string[],
  schema: T,
  scope: string,
): string[] {
  const parsed = z.array(schema).safeParse(values);
  if (!parsed.success) {
    throw badRequest(`Those are not valid ${scope} permissions.`);
  }
  return [...new Set(parsed.data as string[])];
}

/** Adds the granted permissions to an existing membership, never replacing it. */
async function applyServerGrant(
  serverId: string,
  accountId: string,
  granted: Permission[],
): Promise<void> {
  const membership = await prisma.serverMember.findUnique({
    where: { serverId_accountId: { serverId, accountId } },
    select: { id: true, role: true, permissions: true },
  });
  if (!membership) throw badRequest('That account is no longer a member of this server.');

  const { ROLE_PERMISSIONS } = await import('@asp/shared');
  // An empty override means "use the role default", so the effective set has to
  // be materialised before adding to it - otherwise approving one permission
  // would silently strip every other one the role carried.
  const current =
    membership.permissions.length > 0
      ? (membership.permissions as Permission[])
      : [...ROLE_PERMISSIONS[roleToUserRole(membership.role)]];

  await prisma.serverMember.update({
    where: { id: membership.id },
    data: { permissions: [...new Set([...current, ...granted])] },
  });
}

async function applyPanelGrant(accountId: string, granted: PanelPermission[]): Promise<void> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { type: true, panelPermissions: true },
  });
  if (!account) throw notFound('Account not found.');
  if (account.type !== 'SUB_ADMIN') {
    throw badRequest('Panel permissions only apply to sub-admin accounts.');
  }

  await prisma.account.update({
    where: { id: accountId },
    data: { panelPermissions: [...new Set([...account.panelPermissions, ...granted])] },
  });
}

function roleToUserRole(role: string): 'owner' | 'admin' | 'operator' | 'viewer' {
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

function serialiseRequest(row: {
  id: string;
  serverId: string | null;
  requested: string[];
  reason: string;
  status: string;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  server?: { name: string } | null;
  account?: { username: string; type: string } | null;
}) {
  return {
    id: row.id,
    scope: row.serverId ? 'server' : 'panel',
    serverId: row.serverId,
    serverName: row.server?.name ?? null,
    requester: row.account?.username ?? null,
    requesterType: row.account?.type ?? null,
    requested: row.requested,
    reason: row.reason,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}
