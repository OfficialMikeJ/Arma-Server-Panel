/**
 * Authentication and authorisation.
 *
 * Decorates every request with `request.auth`, and exposes guards that routes
 * compose. Order matters: origin verification runs before anything reads a
 * cookie, so a cross-site request never even reaches the session lookup.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Account, Session } from '@prisma/client';
import { SESSION, ROLE_PERMISSIONS, type Permission, type UserRole } from '@asp/shared';
import { prisma } from '../db/client.js';
import { getClientIdentity, ipInAnyCidr, type ClientIdentity } from '../security/client-identity.js';
import { resolveSession } from '../security/session.js';
import { verifyCsrfToken, verifyRequestOrigin, CSRF_FAILURE_MESSAGES, isSafeMethod } from '../security/csrf.js';
import { sha256Hex } from '../security/crypto.js';
import { cookieNames, setSessionCookies } from '../lib/cookies.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { consumeRateLimit, buildKey } from '../security/rate-limit.js';
import { RATE_LIMITS } from '@asp/shared';

export type AuthMethod = 'session' | 'api_key' | 'none';

export interface RequestAuth {
  method: AuthMethod;
  account: Account | null;
  session: Session | null;
  apiKeyId: string | null;
  /** Permissions granted by the API key, or null for a full-privilege session. */
  apiKeyPermissions: Permission[] | null;
  /** Server ids an API key is scoped to. Empty means unrestricted. */
  apiKeyServerIds: string[];
  client: ClientIdentity;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireActiveAccount: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const API_KEY_HEADER = 'x-api-key';

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('auth', null as unknown as RequestAuth);

  app.addHook('onRequest', async (request, reply) => {
    const client = getClientIdentity(request);

    request.auth = {
      method: 'none',
      account: null,
      session: null,
      apiKeyId: null,
      apiKeyPermissions: null,
      apiKeyServerIds: [],
      client,
    };

    // Layer 2 of CSRF defence, applied to every mutating request regardless of
    // how it authenticates.
    const originCheck = verifyRequestOrigin(request);
    if (!originCheck.ok) {
      throw new AppError(403, 'csrf_origin_rejected', CSRF_FAILURE_MESSAGES[originCheck.reason!]);
    }

    const rawApiKey = request.headers[API_KEY_HEADER];
    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

    if (apiKey) {
      await authenticateApiKey(request, apiKey, client);
      return;
    }

    const token = (request.cookies as Record<string, string | undefined>)[cookieNames().session];
    if (!token) return;

    const result = await resolveSession(token, client);
    if (!result.ok || !result.resolved) {
      // An invalid session cookie is cleared so the browser stops sending it.
      if (result.reason !== 'not_found') {
        const { clearSessionCookies } = await import('../lib/cookies.js');
        clearSessionCookies(reply);
      }
      return;
    }

    const { session, account, rotated } = result.resolved;

    // Layer 3: double-submit token, checked against the *pre-rotation* digest -
    // the browser is still holding the cookie it sent with this request.
    if (!isSafeMethod(request.method)) {
      const csrf = verifyCsrfToken(request, result.resolved.csrfTokenHash);
      if (!csrf.ok) {
        throw new AppError(403, 'csrf_token_rejected', CSRF_FAILURE_MESSAGES[csrf.reason!]);
      }
    }

    if (rotated) {
      setSessionCookies(reply, rotated, session.elevated);
    }

    request.auth = {
      method: 'session',
      account,
      session,
      apiKeyId: null,
      apiKeyPermissions: null,
      apiKeyServerIds: [],
      client,
    };
  });

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    if (request.auth.method === 'none' || !request.auth.account) {
      throw unauthorized();
    }
  });

  app.decorate('requireActiveAccount', async (request: FastifyRequest) => {
    const account = request.auth.account;
    if (!account) throw unauthorized();

    if (account.status === 'PENDING_TOTP' || !account.totpVerified) {
      throw new AppError(
        403,
        'totp_enrollment_required',
        'Two-factor authentication must be set up before you can continue.',
      );
    }
    if (account.mustChangePassword) {
      throw new AppError(
        403,
        'password_change_required',
        'You must change your password before you can continue.',
      );
    }
    if (account.status !== 'ACTIVE') {
      throw forbidden('This account is not active.');
    }
  });

  app.decorate('requirePlatformAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(request, reply);
    await app.requireActiveAccount(request, reply);
    const account = request.auth.account!;
    if (account.type !== 'ADMIN' && !account.isPlatformOwner) {
      throw forbidden('Administrator access is required.');
    }
    // Administrative actions require an elevated session, which expires far
    // sooner than a normal one.
    if (request.auth.method === 'session' && request.auth.session && !request.auth.session.elevated) {
      throw new AppError(403, 'step_up_required', 'Re-authenticate to perform administrative actions.');
    }
  });
});

async function authenticateApiKey(
  request: FastifyRequest,
  rawKey: string,
  client: ClientIdentity,
): Promise<void> {
  // Rate limit by key hash before touching the database, so a flood of bogus
  // keys cannot be used to hammer it.
  const keyHash = sha256Hex(rawKey);
  const limit = await consumeRateLimit(buildKey('apikey', keyHash.slice(0, 32)), RATE_LIMITS.apiKey);
  if (!limit.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many requests for this API key.', {
      headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
    });
  }

  const record = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { account: true },
  });

  if (!record || record.revokedAt !== null || record.expiresAt <= new Date()) {
    throw unauthorized('Invalid API key.');
  }

  if (record.allowedCidrs.length > 0 && !ipInAnyCidr(client.ip, record.allowedCidrs)) {
    throw forbidden('This API key may not be used from this address.');
  }

  const account = record.account;
  if (account.deletedAt !== null || account.status !== 'ACTIVE') {
    throw unauthorized('Invalid API key.');
  }

  // Fire and forget - last-used tracking must not add latency to every call.
  void prisma.apiKey
    .update({
      where: { id: record.id },
      data: { lastUsedAt: new Date(), lastUsedIpHash: client.ipHash },
    })
    .catch(() => undefined);

  request.auth = {
    method: 'api_key',
    account,
    session: null,
    apiKeyId: record.id,
    apiKeyPermissions: record.permissions as Permission[],
    apiKeyServerIds: record.serverIds,
    client,
  };
}

/* ------------------------------------------------------------------ */
/* Server-scoped authorisation                                         */
/* ------------------------------------------------------------------ */

export interface ServerAccess {
  serverId: string;
  role: UserRole;
  permissions: Set<Permission>;
  isOwner: boolean;
}

function roleToUserRole(role: string): UserRole {
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
 * Resolves what the caller may do on a given server.
 *
 * Platform administrators are granted access, but the grant is recorded as
 * such so the audit log distinguishes "the owner did this" from "staff did
 * this on the owner's server".
 */
export async function resolveServerAccess(
  request: FastifyRequest,
  serverId: string,
): Promise<ServerAccess> {
  const account = request.auth.account;
  if (!account) throw unauthorized();

  const server = await prisma.server.findFirst({
    where: { id: serverId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!server) {
    // Do not distinguish "does not exist" from "not yours" - that would let a
    // caller enumerate server ids.
    throw new AppError(404, 'not_found', 'Server not found.');
  }

  // API keys can be pinned to specific servers.
  if (request.auth.method === 'api_key' && request.auth.apiKeyServerIds.length > 0) {
    if (!request.auth.apiKeyServerIds.includes(serverId)) {
      throw new AppError(404, 'not_found', 'Server not found.');
    }
  }

  let role: UserRole;
  let permissions: Set<Permission>;

  if (server.ownerId === account.id) {
    role = 'owner';
    permissions = new Set(ROLE_PERMISSIONS.owner);
  } else {
    const membership = await prisma.serverMember.findUnique({
      where: { serverId_accountId: { serverId, accountId: account.id } },
      select: { role: true, permissions: true },
    });

    if (membership) {
      role = roleToUserRole(membership.role);
      permissions =
        membership.permissions.length > 0
          ? new Set(membership.permissions as Permission[])
          : new Set(ROLE_PERMISSIONS[role]);
    } else if (account.type === 'ADMIN' || account.isPlatformOwner) {
      role = 'admin';
      permissions = new Set(ROLE_PERMISSIONS.admin);
    } else {
      throw new AppError(404, 'not_found', 'Server not found.');
    }
  }

  // An API key can only ever narrow what its owner could already do.
  if (request.auth.apiKeyPermissions) {
    const keyPermissions = new Set(request.auth.apiKeyPermissions);
    permissions = new Set([...permissions].filter((p) => keyPermissions.has(p)));
  }

  return { serverId, role, permissions, isOwner: server.ownerId === account.id };
}

export function assertPermission(access: ServerAccess, permission: Permission): void {
  if (!access.permissions.has(permission)) {
    throw forbidden(`You do not have the "${permission}" permission on this server.`);
  }
}
