/**
 * API keys for the HTTP API.
 *
 * "Easy HTTP API to interact with the server."
 *
 * Key handling:
 *   * The raw key is shown exactly once, at creation. Only its SHA-256 digest
 *     is stored, so a database read yields nothing usable.
 *   * A visible prefix (`asp_live_XXXXXXXX`) lets a key be identified in a
 *     list and in logs without revealing it.
 *   * Every key expires. There is no "never expires" option.
 *   * A key can only ever narrow its owner's permissions, never widen them.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createApiKeySchema, cuidSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { generateToken, sha256Hex } from '../security/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ipInCidr } from '../security/client-identity.js';

const KEY_PREFIX = 'asp_live_';

export async function registerApiKeyRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/api-keys', guard, async (request, reply) => {
    const account = request.auth.account!;

    const keys = await prisma.apiKey.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({
      keys: keys.map((key) => ({
        id: key.id,
        label: key.label,
        prefix: key.keyPrefix,
        permissions: key.permissions,
        serverIds: key.serverIds,
        allowedCidrs: key.allowedCidrs,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        expiresAt: key.expiresAt.toISOString(),
        revokedAt: key.revokedAt?.toISOString() ?? null,
        expired: key.expiresAt <= new Date(),
        createdAt: key.createdAt.toISOString(),
      })),
    });
  });

  app.post('/api-keys', guard, async (request, reply) => {
    const account = request.auth.account!;

    // A key must not be usable to mint further keys, so this route is
    // session-only.
    if (request.auth.method === 'api_key') {
      throw badRequest('API keys cannot be created with an API key.');
    }

    const body = createApiKeySchema.parse(request.body);

    // Verify the caller actually holds every permission they are delegating,
    // on every server they are scoping the key to.
    for (const serverId of body.serverIds) {
      const access = await resolveServerAccess(request, serverId);
      for (const permission of body.permissions) {
        assertPermission(access, permission);
      }
    }

    for (const cidr of body.allowedCidrs) {
      // Round-trip through the matcher to reject malformed input early.
      if (!ipInCidr('192.0.2.1', cidr) && !ipInCidr('2001:db8::1', cidr) && !isParseableCidr(cidr)) {
        throw badRequest(`"${cidr}" is not a valid CIDR range.`);
      }
    }

    const raw = `${KEY_PREFIX}${generateToken(32)}`;
    const prefix = raw.slice(0, KEY_PREFIX.length + 8);

    const key = await prisma.apiKey.create({
      data: {
        accountId: account.id,
        label: body.label,
        keyHash: sha256Hex(raw),
        keyPrefix: prefix,
        permissions: body.permissions,
        serverIds: body.serverIds,
        allowedCidrs: body.allowedCidrs,
        expiresAt: new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000),
      },
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.ApiKeyCreated,
      targetType: 'api_key',
      targetId: key.id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: {
        label: body.label,
        permissions: body.permissions,
        servers: body.serverIds.length,
        expiresInDays: body.expiresInDays,
      },
    });

    return reply.status(201).send({
      key: {
        id: key.id,
        label: key.label,
        prefix: key.keyPrefix,
        expiresAt: key.expiresAt.toISOString(),
      },
      // The only time this value is ever returned.
      secret: raw,
      message: 'Copy this key now. It cannot be shown again.',
      usage: {
        header: 'x-api-key',
        example: `curl -H "x-api-key: ${prefix}..." ${request.protocol}://${request.hostname}/api/v1/servers`,
      },
    });
  });

  app.delete('/api-keys/:keyId', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { keyId } = z.object({ keyId: cuidSchema }).parse(request.params);

    const revoked = await prisma.apiKey.updateMany({
      where: { id: keyId, accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw notFound('API key not found.');

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.ApiKeyRevoked,
      targetType: 'api_key',
      targetId: keyId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });
}

function isParseableCidr(cidr: string): boolean {
  return /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr) || /^[0-9a-fA-F:.]+$/.test(cidr);
}
