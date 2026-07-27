/**
 * First-run setup.
 *
 * Setup can only complete when every gate is satisfied:
 *   1. The host meets the hard-coded minimum requirements.
 *   2. The container runtime is reachable.
 *   3. The default admin password has been changed.
 *   4. TOTP is enrolled on the admin account.
 *   5. At least one node is registered.
 *
 * Until then `registrationOpen` reports false and no server can be created.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOST_REQUIREMENTS, formatBytes } from '@asp/shared';
import { prisma } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { audit, AuditAction } from '../security/audit.js';
import { getClientIdentity } from '../security/client-identity.js';
import { AppError, forbidden, preconditionFailed } from '../lib/errors.js';
import { checkDockerHealth } from '../modules/docker/docker-client.js';
import { ensureServerNetwork } from '../modules/docker/container-manager.js';
import {
  evaluateHostRequirements,
  refreshHostRequirements,
} from '../modules/host/host-requirements.js';
import { getPlatformSettings, updatePlatformSettings } from '../modules/platform/platform-settings.js';
import { getNatEnvironment } from '../modules/network/port-forwarder.js';
import { isRelayConfigured } from '../modules/network/relay.js';

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Setup status.
   *
   * Readable without authentication *only* while setup is incomplete - once
   * the panel is live this would leak host capacity details, so it locks down.
   */
  app.get('/setup/status', async (request, reply) => {
    const settings = await getPlatformSettings();

    if (settings.setupComplete) {
      if (!request.auth.account || request.auth.account.type !== 'ADMIN') {
        throw forbidden('Setup has already been completed.');
      }
    }

    const [docker, admin, nodeCount] = await Promise.all([
      checkDockerHealth(),
      prisma.account.findFirst({
        where: { type: 'ADMIN', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { username: true, mustChangePassword: true, totpVerified: true },
      }),
      prisma.node.count(),
    ]);

    const report = (settings.requirementsReport as { checks?: unknown[] } | null) ?? null;

    return reply.send({
      setupComplete: settings.setupComplete,
      steps: {
        requirements: {
          done: settings.requirementsPass,
          checkedAt: settings.requirementsCheckedAt?.toISOString() ?? null,
          checks: report?.checks ?? [],
        },
        containerRuntime: {
          done: docker.available,
          userNsRemap: docker.userNsRemap,
          message: docker.message,
        },
        adminPassword: { done: !(admin?.mustChangePassword ?? true) },
        adminTotp: { done: admin?.totpVerified ?? false },
        node: { done: nodeCount > 0, count: nodeCount },
      },
      minimum: {
        memory: formatBytes(HOST_REQUIREMENTS.minMemoryBytes),
        cpuThreads: HOST_REQUIREMENTS.minCpuThreads,
        storage: formatBytes(HOST_REQUIREMENTS.minStorageBytes),
        downloadMbps: HOST_REQUIREMENTS.minDownloadMbps,
        uploadMbps: HOST_REQUIREMENTS.minUploadMbps,
      },
    });
  });

  /** Runs the requirements check, optionally with a fresh throughput test. */
  app.post('/setup/requirements/check', async (request, reply) => {
    const settings = await getPlatformSettings();
    if (settings.setupComplete) {
      await app.requirePlatformAdmin(request, reply);
    }

    const body = z
      .object({ runSpeedTest: z.boolean().default(true) })
      .parse(request.body ?? {});

    const report = await evaluateHostRequirements({ forceSpeedTest: body.runSpeedTest });

    await updatePlatformSettings({
      requirementsPass: report.pass,
      requirementsCheckedAt: new Date(),
      requirementsReport: {
        checks: report.checks,
        capabilities: report.capabilities,
        throughput: report.throughput,
        checkedAt: report.checkedAt,
      } as never,
    });

    const client = getClientIdentity(request);
    await audit({
      accountId: request.auth.account?.id ?? null,
      actorLabel: request.auth.account?.username ?? 'setup',
      action: report.pass ? AuditAction.RequirementsChecked : AuditAction.RequirementsFailed,
      outcome: report.pass ? 'success' : 'failure',
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      metadata: { failing: report.checks.filter((c) => !c.pass).map((c) => c.key) },
    });

    return reply.send({
      pass: report.pass,
      checks: report.checks,
      capabilities: {
        cpuModel: report.capabilities.cpuModel,
        cpuThreads: report.capabilities.cpuThreads,
        memoryBytes: report.capabilities.memoryBytes,
        storageTotalBytes: report.capabilities.storageTotalBytes,
        storageFreeBytes: report.capabilities.storageFreeBytes,
        platform: report.capabilities.platform,
        arch: report.capabilities.arch,
      },
      throughput: report.throughput,
    });
  });

  /** Network capability probe, shown in the setup wizard. */
  app.post(
    '/setup/network/probe',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const account = request.auth.account!;
      if (account.type !== 'ADMIN') throw forbidden('Administrator access is required.');

      const environment = await getNatEnvironment(true);

      return reply.send({
        localAddress: environment.localAddress,
        gateway: environment.gateway,
        // The external address is the operator's own; only shown to them.
        externalAddress: environment.externalAddress,
        behindCgnat: environment.behindCgnat,
        directPublic: environment.directPublic,
        methods: {
          natpmp: environment.natpmpAvailable,
          pcp: environment.pcpAvailable,
          upnp: environment.upnpAvailable,
          relay: isRelayConfigured(),
        },
        // Ordered by how much the operator can actually do about it. A machine
        // on a public address is the simplest case and is checked first, so a
        // data-centre or home-lab install is never told to configure a router.
        recommendation: environment.directPublic
          ? 'This machine holds a public address, so servers are reachable with no port forwarding at all. ' +
            'Open the panel’s port range on the host firewall and any provider security group, and you are done.'
          : environment.behindCgnat
            ? 'Your ISP uses carrier-grade NAT. No router setting can open an inbound port - use relay mode.'
            : environment.natpmpAvailable || environment.pcpAvailable || environment.upnpAvailable
              ? 'Automatic port forwarding is available. Players will see this connection’s public IP address; ' +
                'use relay mode instead if that matters to you.'
              : isRelayConfigured()
                ? 'No automatic port forwarding was detected, but relay mode is configured and will work.'
                : 'No automatic port forwarding was detected. Enable UPnP or NAT-PMP on your router, ' +
                  'forward the port range by hand, or configure relay mode.',
      });
    },
  );

  /** Finalises setup. Refuses unless every gate passes. */
  app.post(
    '/setup/complete',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const account = request.auth.account!;
      if (account.type !== 'ADMIN') throw forbidden('Administrator access is required.');

      const settings = await getPlatformSettings();
      if (settings.setupComplete) {
        throw new AppError(409, 'already_complete', 'Setup has already been completed.');
      }

      const blockers: string[] = [];

      const report = await refreshHostRequirements({ runSpeedTest: false });
      if (!report.pass) {
        blockers.push(
          `Host requirements not met: ${report.checks.filter((c) => !c.pass).map((c) => c.label).join(', ')}`,
        );
      }

      const docker = await checkDockerHealth();
      if (!docker.available) blockers.push('The container runtime is not reachable.');

      if (account.mustChangePassword) blockers.push('The default administrator password has not been changed.');
      if (!account.totpVerified) blockers.push('Two-factor authentication is not set up on the administrator account.');

      const nodeCount = await prisma.node.count();
      if (nodeCount === 0) blockers.push('No node has been registered.');

      if (blockers.length > 0) {
        throw preconditionFailed(
          `Setup cannot be completed yet: ${blockers.join(' ')}`,
          'setup_blocked',
        );
      }

      await ensureServerNetwork();

      await updatePlatformSettings({
        setupComplete: true,
        // The shipped default credential is retired permanently here as well
        // as on password change, so there is no path that leaves it live.
        bootstrapCredentialActive: false,
        registrationOpen: true,
      });

      const client = getClientIdentity(request);
      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.SetupCompleted,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
      });

      return reply.send({
        ok: true,
        message: 'Setup complete. Registration is now open.',
        appUrl: loadConfig().appOrigin,
      });
    },
  );
}
