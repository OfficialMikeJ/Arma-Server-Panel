/**
 * Unauthenticated content for the marketing site.
 *
 * Everything here is public by design and cached at the edge, so nothing
 * account-specific may be returned from these handlers.
 */

import type { FastifyInstance } from 'fastify';
import { GAMES, GAME_IDS, HOST_REQUIREMENTS, PRICING, RESOURCE_LIMITS, formatBytes } from '@asp/shared';
import { prisma } from '../db/client.js';
import { getPlatformSettings, isRegistrationOpen } from '../modules/platform/platform-settings.js';
import { isDiscordEnabled } from '../modules/auth/discord.js';

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public/games', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return reply.send({
      games: GAME_IDS.map((id) => {
        const game = GAMES[id];
        return {
          id: game.id,
          name: game.name,
          shortName: game.shortName,
          released: game.released,
          slots: { default: game.defaultSlots, max: game.maxSlots },
          recommended: {
            cpuCores: game.cpu.recommended,
            memoryGb: game.memoryMib.recommended / 1024,
            storageGb: game.storageGib.recommended,
          },
          features: {
            mods: game.modSource !== 'none',
            rcon: game.battleyeRcon,
            a2s: game.a2sQuery,
            persistence: game.persistence,
          },
        };
      }),
    });
  });

  app.get('/public/pricing', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return reply.send({
      perSlot: {
        priceUsdMonthly: PRICING.perSlotUsdMonthly,
        currency: PRICING.currency,
        trialDays: PRICING.trialDays,
      },
      resourceLimits: {
        cpu: RESOURCE_LIMITS.cpu,
        memoryGb: {
          min: RESOURCE_LIMITS.memoryMib.min / 1024,
          max: RESOURCE_LIMITS.memoryMib.max / 1024,
        },
        storageGb: RESOURCE_LIMITS.storageGib,
        bandwidthMbps: RESOURCE_LIMITS.bandwidthMbps,
        slots: RESOURCE_LIMITS.slots,
      },
    });
  });

  app.get('/public/locations', async (_request, reply) => {
    // Only nodes an operator has published, and only non-identifying fields.
    const nodes = await prisma.node.findMany({
      where: { status: { in: ['ONLINE', 'DEGRADED'] } },
      select: {
        id: true,
        locationLabel: true,
        region: true,
        status: true,
        totalCpuThreads: true,
        totalMemoryMib: true,
      },
      orderBy: { locationLabel: 'asc' },
    });

    reply.header('cache-control', 'public, max-age=120');
    return reply.send({
      locations: nodes.map((node) => ({
        id: node.id,
        label: node.locationLabel,
        region: node.region,
        status: node.status === 'ONLINE' ? 'online' : 'degraded',
      })),
    });
  });

  app.get('/public/requirements', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return reply.send({
      minimum: {
        memory: formatBytes(HOST_REQUIREMENTS.minMemoryBytes),
        cpuThreads: HOST_REQUIREMENTS.minCpuThreads,
        storage: formatBytes(HOST_REQUIREMENTS.minStorageBytes),
        downloadMbps: HOST_REQUIREMENTS.minDownloadMbps,
        uploadMbps: HOST_REQUIREMENTS.minUploadMbps,
      },
      note: 'These are hard requirements. A host that does not meet them cannot run the panel or accept registrations.',
    });
  });

  app.get('/public/status', async (_request, reply) => {
    const [settings, registration] = await Promise.all([
      getPlatformSettings(),
      isRegistrationOpen(),
    ]);

    reply.header('cache-control', 'no-store');
    return reply.send({
      setupComplete: settings.setupComplete,
      registrationOpen: registration.open,
      registrationMessage: registration.reason ?? null,
      discordEnabled: isDiscordEnabled(),
      // The detailed requirements report is admin-only; expose only the verdict.
      hostRequirementsMet: settings.requirementsPass,
    });
  });
}
