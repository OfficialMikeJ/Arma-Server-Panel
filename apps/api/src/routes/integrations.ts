import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cuidSchema, discordIntegrationSchema, pushoverIntegrationSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { encryptSecret } from '../security/crypto.js';
import { notFound } from '../lib/errors.js';
import {
  assertUrlIsSafe,
  DISCORD_WEBHOOK_HOSTS,
} from '../security/ssrf.js';
import { sendTestEvent } from '../modules/integrations/dispatcher.js';

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/servers/:id/integrations', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const integrations = await prisma.integration.findMany({
      where: { serverId: id },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      integrations: integrations.map((integration) => ({
        id: integration.id,
        kind: integration.kind,
        label: integration.label,
        enabled: integration.enabled,
        events: integration.events,
        lastSentAt: integration.lastSentAt?.toISOString() ?? null,
        failureCount: integration.failureCount,
        // The webhook URL and tokens are never returned - they are write-only.
      })),
    });
  });

  app.post('/servers/:id/integrations/discord', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const body = z
      .object({ label: z.string().trim().min(1).max(64).default('Discord') })
      .merge(discordIntegrationSchema)
      .parse(request.body);

    // Validated at creation *and* again at every send, because DNS can change.
    await assertUrlIsSafe(body.webhookUrl, DISCORD_WEBHOOK_HOSTS);

    const integration = await prisma.integration.create({
      data: {
        serverId: id,
        kind: 'DISCORD_WEBHOOK',
        label: body.label,
        enabled: body.enabled,
        events: body.events,
        secretsEnc: encryptSecret(JSON.stringify({ webhookUrl: body.webhookUrl }), 'integration'),
      },
    });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.IntegrationCreated,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { kind: 'discord', events: body.events },
    });

    return reply.status(201).send({
      integration: { id: integration.id, kind: integration.kind, label: integration.label },
    });
  });

  app.post('/servers/:id/integrations/pushover', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const body = z
      .object({ label: z.string().trim().min(1).max(64).default('Pushover') })
      .merge(pushoverIntegrationSchema)
      .parse(request.body);

    const integration = await prisma.integration.create({
      data: {
        serverId: id,
        kind: 'PUSHOVER',
        label: body.label,
        enabled: body.enabled,
        events: body.events,
        secretsEnc: encryptSecret(
          JSON.stringify({ userKey: body.userKey, apiToken: body.apiToken }),
          'integration',
        ),
      },
    });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.IntegrationCreated,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { kind: 'pushover', events: body.events },
    });

    return reply.status(201).send({
      integration: { id: integration.id, kind: integration.kind, label: integration.label },
    });
  });

  app.post('/servers/:id/integrations/:integrationId/test', guard, async (request, reply) => {
    const { id, integrationId } = z
      .object({ id: cuidSchema, integrationId: cuidSchema })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, serverId: id },
    });
    if (!integration) throw notFound('Integration not found.');

    try {
      await sendTestEvent(integrationId);
      return reply.send({ ok: true, message: 'Test notification sent.' });
    } catch (error) {
      return reply.status(502).send({
        error: {
          code: 'integration_test_failed',
          message: error instanceof Error ? error.message : 'The destination did not accept the test.',
          requestId: request.id,
        },
      });
    }
  });

  app.patch('/servers/:id/integrations/:integrationId', guard, async (request, reply) => {
    const { id, integrationId } = z
      .object({ id: cuidSchema, integrationId: cuidSchema })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const body = z
      .object({
        enabled: z.boolean().optional(),
        label: z.string().trim().min(1).max(64).optional(),
        events: z.array(z.string().max(32)).max(16).optional(),
      })
      .parse(request.body);

    const updated = await prisma.integration.updateMany({
      where: { id: integrationId, serverId: id },
      data: {
        ...body,
        // Re-enabling clears the failure counter that auto-disabled it.
        ...(body.enabled === true ? { failureCount: 0 } : {}),
      },
    });
    if (updated.count === 0) throw notFound('Integration not found.');

    return reply.send({ ok: true });
  });

  app.delete('/servers/:id/integrations/:integrationId', guard, async (request, reply) => {
    const { id, integrationId } = z
      .object({ id: cuidSchema, integrationId: cuidSchema })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:integrations');

    const deleted = await prisma.integration.deleteMany({
      where: { id: integrationId, serverId: id },
    });
    if (deleted.count === 0) throw notFound('Integration not found.');

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.IntegrationRemoved,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });
}
