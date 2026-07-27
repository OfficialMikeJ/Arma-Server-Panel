import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cuidSchema, portForwardRequestSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { getServerPorts } from '../modules/network/port-allocator.js';
import {
  forwardServerPorts,
  getNatEnvironment,
  releaseServerPortMappings,
} from '../modules/network/port-forwarder.js';
import { isRelayConfigured } from '../modules/network/relay.js';
import { loadServer } from '../modules/servers/server-service.js';
import { probeReachability } from '../modules/network/reachability.js';

export async function registerNetworkRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/servers/:id/network', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const [server, ports, environment] = await Promise.all([
      loadServer(id),
      getServerPorts(id),
      getNatEnvironment(),
    ]);

    return reply.send({
      address: `${server.publicHost}:${server.publicBasePort}`,
      useRelay: server.useRelay,
      autoPortForward: server.autoPortForward,
      relayAvailable: isRelayConfigured(),
      behindCgnat: environment.behindCgnat,
      directPublic: environment.directPublic,
      availableMethods: {
        natpmp: environment.natpmpAvailable,
        pcp: environment.pcpAvailable,
        upnp: environment.upnpAvailable,
        relay: isRelayConfigured(),
      },
      ports: ports.map((port) => ({
        key: port.portKey,
        protocol: port.protocol,
        internal: port.internalPort,
        external: port.externalPort,
        method: port.method.toLowerCase(),
        active: port.active,
        reachable: port.reachable,
        leaseExpiresAt: port.leaseExpiresAt?.toISOString() ?? null,
        lastVerifiedAt: port.lastVerifiedAt?.toISOString() ?? null,
        message: port.message,
      })),
      // Surfaced so the UI can be honest about the privacy trade-off - without
      // treating a hosted machine's address as something that leaked. On a VPS
      // or a colocated box the public address is the point.
      privacyNote: server.useRelay
        ? 'Traffic is routed through the relay. Players see the relay address, not this machine’s.'
        : environment.directPublic
          ? 'Players connect straight to this machine’s public address, which is what a hosted deployment is for. Relay mode is available if you would rather it stayed hidden.'
          : 'Players connect directly, which means they can see this connection’s public IP address. Enable relay mode to keep it private.',
    });
  });

  /** Opens (or re-opens) the server's public ports. */
  app.post('/servers/:id/network/forward', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:network');

    const body = portForwardRequestSchema.parse(request.body ?? {});

    const outcomes = await forwardServerPorts({
      serverId: id,
      preferred: body.preferred,
      leaseSeconds: body.leaseSeconds,
      actor: {
        accountId: request.auth.account!.id,
        username: request.auth.account!.username,
        ipHash: request.auth.client.ipHash,
        userAgentHash: request.auth.client.userAgentHash,
      },
    });

    const succeeded = outcomes.filter((o) => o.success);
    const exposesIp = succeeded.some((o) => o.exposesHostIp);

    return reply.send({
      results: outcomes,
      summary: {
        opened: succeeded.length,
        total: outcomes.length,
        allSucceeded: succeeded.length === outcomes.length,
        exposesHostIp: exposesIp,
      },
      // Never soften this: the operator needs to know their address is visible.
      warning: exposesIp
        ? 'These ports are forwarded directly, so players can see this connection’s public IP address. Use relay mode if that matters to you.'
        : null,
    });
  });

  app.post('/servers/:id/network/release', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:network');

    await releaseServerPortMappings(id);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.PortMappingRemoved,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });

  /** External reachability probe - does the outside world actually see us? */
  app.post('/servers/:id/network/verify', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:network');

    const results = await probeReachability(id);
    return reply.send({ results });
  });

  app.patch('/servers/:id/network', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:network');

    const body = z
      .object({
        useRelay: z.boolean().optional(),
        autoPortForward: z.boolean().optional(),
      })
      .parse(request.body);

    if (body.useRelay === true && !isRelayConfigured()) {
      const { preconditionFailed } = await import('../lib/errors.js');
      throw preconditionFailed(
        'Relay mode is not configured on this node. Set RELAY_ENDPOINT and RELAY_TOKEN, or deploy the relay daemon from the repository.',
        'relay_unavailable',
      );
    }

    const updated = await prisma.server.update({ where: { id }, data: body });

    if (body.useRelay !== undefined) {
      // Switching modes invalidates existing mappings.
      await releaseServerPortMappings(id).catch(() => undefined);
      await audit({
        accountId: request.auth.account!.id,
        actorLabel: request.auth.account!.username,
        action: AuditAction.RelayEnabled,
        targetType: 'server',
        targetId: id,
        ipHash: request.auth.client.ipHash,
        userAgentHash: request.auth.client.userAgentHash,
        metadata: { useRelay: body.useRelay },
      });
    }

    return reply.send({
      useRelay: updated.useRelay,
      autoPortForward: updated.autoPortForward,
      message:
        body.useRelay !== undefined
          ? 'Networking mode changed. Re-open the ports to apply it.'
          : 'Updated.',
    });
  });
}
