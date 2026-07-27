/**
 * Node management. Platform-administrator only.
 *
 * A node may only be brought ONLINE once it passes the same hard-coded host
 * requirements the panel itself is gated on, so capacity can never be sold on
 * hardware that does not meet the floor.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOST_REQUIREMENTS, cuidSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { audit, AuditAction } from '../security/audit.js';
import { encryptSecret } from '../security/crypto.js';
import { notFound, preconditionFailed } from '../lib/errors.js';
import { checkDockerHealth } from '../modules/docker/docker-client.js';
import { detectHostCapabilities, evaluateHostRequirements } from '../modules/host/host-requirements.js';
import { getNodeCapacity } from '../modules/servers/server-service.js';
import { getNatEnvironment } from '../modules/network/port-forwarder.js';
import { isRelayConfigured } from '../modules/network/relay.js';

const createNodeSchema = z.object({
  name: z.string().trim().min(2).max(48).regex(/^[A-Za-z0-9 _-]+$/, 'Invalid node name'),
  region: z.string().trim().min(2).max(32),
  locationLabel: z.string().trim().min(2).max(64),
  /** Unix socket path, or an https endpoint for a remote daemon. */
  dockerEndpoint: z.string().trim().min(1).max(256).default('/var/run/docker.sock'),
  dataRoot: z.string().trim().min(1).max(512),
  publicHost: z.string().trim().min(1).max(255),
  /// Defaults to true whenever publicHost is stated explicitly.
  staticPublicHost: z.boolean().optional(),
  portRangeStart: z.number().int().min(1024).max(65000).default(2001),
  portRangeEnd: z.number().int().min(1024).max(65535).default(40000),
  relayEnabled: z.boolean().default(false),
  relayEndpoint: z.string().max(256).nullable().default(null),
  /** PEM bundle for a remote Docker daemon. Stored encrypted. */
  dockerTls: z
    .object({ ca: z.string().max(16384), cert: z.string().max(16384), key: z.string().max(16384) })
    .nullable()
    .default(null),
});

export async function registerNodeRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = { onRequest: [app.requirePlatformAdmin] };
  const userGuard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /** Nodes visible when creating a server - non-identifying fields only. */
  app.get('/nodes', userGuard, async (_request, reply) => {
    const nodes = await prisma.node.findMany({
      where: { status: 'ONLINE', requirementsPass: true },
      orderBy: { locationLabel: 'asc' },
      select: {
        id: true,
        name: true,
        region: true,
        locationLabel: true,
        relayEnabled: true,
      },
    });

    const withCapacity = await Promise.all(
      nodes.map(async (node) => ({
        ...node,
        capacity: await getNodeCapacity(node.id),
      })),
    );

    return reply.send({ nodes: withCapacity });
  });

  /** Full detail, administrators only. */
  app.get('/admin/nodes', adminGuard, async (_request, reply) => {
    const nodes = await prisma.node.findMany({ orderBy: { createdAt: 'asc' } });

    const detailed = await Promise.all(
      nodes.map(async (node) => ({
        id: node.id,
        name: node.name,
        region: node.region,
        locationLabel: node.locationLabel,
        status: node.status,
        publicHost: node.publicHost,
        staticPublicHost: node.staticPublicHost,
        dataRoot: node.dataRoot,
        portRange: { start: node.portRangeStart, end: node.portRangeEnd },
        relayEnabled: node.relayEnabled,
        requirementsPass: node.requirementsPass,
        requirementsCheckedAt: node.requirementsCheckedAt?.toISOString() ?? null,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
        hardware: {
          cpuThreads: node.totalCpuThreads,
          memoryMib: node.totalMemoryMib,
          storageGib: node.totalStorageGib,
          downloadMbps: node.downloadMbps,
          uploadMbps: node.uploadMbps,
        },
        capacity: await getNodeCapacity(node.id),
      })),
    );

    return reply.send({ nodes: detailed });
  });

  /**
   * Registers the machine the API is running on.
   *
   * Capacity is *detected*, not accepted from the request body - an operator
   * cannot declare 64 GB on an 8 GB box and oversell it.
   */
  app.post('/admin/nodes/local', adminGuard, async (request, reply) => {
    const config = loadConfig();
    const body = createNodeSchema.partial({ dataRoot: true, publicHost: true }).parse(request.body);

    const [capabilities, report, docker, environment] = await Promise.all([
      detectHostCapabilities(),
      evaluateHostRequirements({ runSpeedTest: true }),
      checkDockerHealth(),
      getNatEnvironment(),
    ]);

    if (!docker.available) {
      throw preconditionFailed(
        'The container runtime is not reachable, so this node cannot be registered.',
        'docker_unavailable',
      );
    }

    if (!report.pass) {
      throw preconditionFailed(
        `This host does not meet the minimum requirements (${HOST_REQUIREMENTS.minMemoryBytes / 1024 ** 3} GB RAM, ` +
          `${HOST_REQUIREMENTS.minCpuThreads} threads, ${HOST_REQUIREMENTS.minStorageBytes / 1000 ** 3} GB storage, ` +
          `${HOST_REQUIREMENTS.minDownloadMbps} Mbps up/down). Failing: ` +
          report.checks.filter((c) => !c.pass).map((c) => c.label).join(', '),
        'host_requirements_not_met',
      );
    }

    const publicHost =
      body.publicHost ?? config.PUBLIC_GAME_HOST ?? environment.externalAddress ?? '';

    // Stated by the operator - a static IP, or a DNS name they control - rather
    // than discovered from the router. Fixed addresses do not need
    // rediscovering, and a port forwarded once by hand stays forwarded.
    const staticPublicHost =
      body.staticPublicHost ?? Boolean(body.publicHost ?? config.PUBLIC_GAME_HOST);

    if (!publicHost) {
      throw preconditionFailed(
        'Could not determine a public address for this node. Set PUBLIC_GAME_HOST or supply publicHost.',
        'public_host_unknown',
      );
    }

    const node = await prisma.node.create({
      data: {
        name: body.name,
        region: body.region,
        locationLabel: body.locationLabel,
        status: 'ONLINE',
        dockerEndpoint: body.dockerEndpoint,
        dockerTlsEnc: body.dockerTls
          ? encryptSecret(JSON.stringify(body.dockerTls), 'docker-tls')
          : null,
        dataRoot: body.dataRoot ?? config.DATA_ROOT,
        totalCpuThreads: capabilities.cpuThreads,
        totalMemoryMib: Math.floor(capabilities.memoryBytes / 1024 / 1024),
        totalStorageGib: Math.floor(capabilities.storageTotalBytes / 1024 ** 3),
        downloadMbps: Math.round(report.throughput?.downloadMbps ?? 0),
        uploadMbps: Math.round(report.throughput?.uploadMbps ?? 0),
        publicHost,
        staticPublicHost,
        relayEnabled: body.relayEnabled && isRelayConfigured(),
        relayEndpoint: body.relayEndpoint,
        portRangeStart: body.portRangeStart,
        portRangeEnd: body.portRangeEnd,
        requirementsPass: true,
        requirementsCheckedAt: new Date(),
        lastSpeedTestAt: report.throughput?.measuredAt ?? null,
        lastHeartbeatAt: new Date(),
      },
    });

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.NodeRegistered,
      targetType: 'node',
      targetId: node.id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: {
        name: node.name,
        cpuThreads: node.totalCpuThreads,
        memoryMib: node.totalMemoryMib,
      },
    });

    return reply.status(201).send({
      node: { id: node.id, name: node.name, status: node.status },
      detected: {
        cpuModel: capabilities.cpuModel,
        cpuThreads: capabilities.cpuThreads,
        memoryBytes: capabilities.memoryBytes,
        storageTotalBytes: capabilities.storageTotalBytes,
        downloadMbps: report.throughput?.downloadMbps ?? null,
        uploadMbps: report.throughput?.uploadMbps ?? null,
      },
    });
  });

  app.patch('/admin/nodes/:nodeId', adminGuard, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: cuidSchema }).parse(request.params);
    const body = z
      .object({
        status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE', 'MAINTENANCE']).optional(),
        locationLabel: z.string().trim().min(2).max(64).optional(),
        publicHost: z.string().trim().min(1).max(255).optional(),
        staticPublicHost: z.boolean().optional(),
        relayEnabled: z.boolean().optional(),
        portRangeStart: z.number().int().min(1024).max(65000).optional(),
        portRangeEnd: z.number().int().min(1024).max(65535).optional(),
      })
      .parse(request.body);

    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw notFound('Node not found.');

    // A node cannot be brought online while it is failing the requirements.
    if (body.status === 'ONLINE' && !node.requirementsPass) {
      throw preconditionFailed(
        'This node cannot be brought online until it passes the host requirements check.',
        'host_requirements_not_met',
      );
    }

    // Stating an address is itself the statement that it is fixed. Without this
    // an operator could set their static IP and still be told, on every attempt,
    // that automatic port opening had failed.
    const data =
      body.publicHost !== undefined && body.staticPublicHost === undefined
        ? { ...body, staticPublicHost: true }
        : body;

    const updated = await prisma.node.update({ where: { id: nodeId }, data });
    return reply.send({ node: { id: updated.id, status: updated.status } });
  });

  /** Re-runs the requirements check for a node. */
  app.post('/admin/nodes/:nodeId/recheck', adminGuard, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: cuidSchema }).parse(request.params);

    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw notFound('Node not found.');

    const [capabilities, report] = await Promise.all([
      detectHostCapabilities(),
      evaluateHostRequirements({ forceSpeedTest: true }),
    ]);

    const updated = await prisma.node.update({
      where: { id: nodeId },
      data: {
        totalCpuThreads: capabilities.cpuThreads,
        totalMemoryMib: Math.floor(capabilities.memoryBytes / 1024 / 1024),
        totalStorageGib: Math.floor(capabilities.storageTotalBytes / 1024 ** 3),
        downloadMbps: Math.round(report.throughput?.downloadMbps ?? 0),
        uploadMbps: Math.round(report.throughput?.uploadMbps ?? 0),
        requirementsPass: report.pass,
        requirementsCheckedAt: new Date(),
        lastSpeedTestAt: report.throughput?.measuredAt ?? null,
        // A node that starts failing is taken out of rotation automatically.
        ...(report.pass ? {} : { status: 'DEGRADED' as const }),
      },
    });

    return reply.send({
      pass: report.pass,
      checks: report.checks,
      status: updated.status,
    });
  });

  app.delete('/admin/nodes/:nodeId', adminGuard, async (request, reply) => {
    const { nodeId } = z.object({ nodeId: cuidSchema }).parse(request.params);

    const serverCount = await prisma.server.count({ where: { nodeId, deletedAt: null } });
    if (serverCount > 0) {
      throw preconditionFailed(
        `This node still hosts ${serverCount} server${serverCount === 1 ? '' : 's'}. Move or delete them first.`,
        'node_in_use',
      );
    }

    await prisma.node.delete({ where: { id: nodeId } });
    return reply.send({ ok: true });
  });

  /* ---- Platform audit access ---- */

  app.get('/admin/audit', adminGuard, async (request, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        action: z.string().max(64).optional(),
        targetId: z.string().max(64).optional(),
      })
      .parse(request.query ?? {});

    const entries = await prisma.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
      },
      orderBy: { at: 'desc' },
      take: query.limit,
    });

    return reply.send({
      entries: entries.map((entry) => ({
        id: entry.id.toString(),
        at: entry.at.toISOString(),
        actor: entry.actorLabel,
        accountId: entry.accountId,
        action: entry.action,
        target: entry.targetType ? { type: entry.targetType, id: entry.targetId } : null,
        outcome: entry.outcome,
        metadata: entry.metadata,
      })),
    });
  });

  /** Verifies the audit hash chain has not been tampered with. */
  app.post('/admin/audit/verify', adminGuard, async (_request, reply) => {
    const { verifyAuditChain } = await import('../security/audit.js');
    const result = await verifyAuditChain();
    return reply.send(result);
  });
}
