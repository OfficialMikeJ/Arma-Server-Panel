/**
 * Performance metrics.
 *
 * "We don't hide your server performance from you. Graphs and logs with events
 * history. For days, not minutes."
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cuidSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';

const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;

export async function registerMetricRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/servers/:id/metrics', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const query = z
      .object({
        range: z.enum(['1h', '6h', '24h', '7d', '30d']).default('6h'),
        // Cap the returned point count so a wide range cannot be used to pull
        // hundreds of thousands of rows.
        points: z.coerce.number().int().min(30).max(720).default(240),
      })
      .parse(request.query ?? {});

    const since = new Date(Date.now() - RANGES[query.range]);

    const samples = await prisma.metricSample.findMany({
      where: { serverId: id, at: { gte: since } },
      orderBy: { at: 'asc' },
      select: {
        at: true,
        cpuPercent: true,
        memoryBytes: true,
        memoryLimitBytes: true,
        netRxBytes: true,
        netTxBytes: true,
        diskBytes: true,
        playersOnline: true,
        fps: true,
      },
    });

    // Downsample by bucketing rather than by taking every Nth point, so spikes
    // are not silently dropped from the graph.
    const bucketed = downsample(samples, query.points);

    return reply.send({
      range: query.range,
      series: bucketed.map((sample) => ({
        at: sample.at.toISOString(),
        cpuPercent: Number(sample.cpuPercent.toFixed(2)),
        memoryBytes: Number(sample.memoryBytes),
        memoryLimitBytes: Number(sample.memoryLimitBytes),
        netRxBytes: Number(sample.netRxBytes),
        netTxBytes: Number(sample.netTxBytes),
        playersOnline: sample.playersOnline,
        fps: sample.fps,
      })),
      summary: summarise(samples),
    });
  });

  app.get('/servers/:id/metrics/current', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const [latest, server] = await Promise.all([
      prisma.metricSample.findFirst({ where: { serverId: id }, orderBy: { at: 'desc' } }),
      prisma.server.findFirst({
        where: { id, deletedAt: null },
        select: { state: true, playersOnline: true, slots: true, memoryMib: true, cpuCores: true },
      }),
    ]);

    return reply.send({
      state: server?.state.toLowerCase() ?? 'offline',
      playersOnline: server?.playersOnline ?? 0,
      slots: server?.slots ?? 0,
      current: latest
        ? {
            at: latest.at.toISOString(),
            cpuPercent: Number(latest.cpuPercent.toFixed(2)),
            cpuLimitPercent: (server?.cpuCores ?? 1) * 100,
            memoryBytes: Number(latest.memoryBytes),
            memoryLimitBytes: Number(latest.memoryLimitBytes),
            netRxBytes: Number(latest.netRxBytes),
            netTxBytes: Number(latest.netTxBytes),
            fps: latest.fps,
          }
        : null,
    });
  });
}

interface Sample {
  at: Date;
  cpuPercent: number;
  memoryBytes: bigint;
  memoryLimitBytes: bigint;
  netRxBytes: bigint;
  netTxBytes: bigint;
  diskBytes: bigint;
  playersOnline: number;
  fps: number | null;
}

/** Averages within each bucket but keeps the peak CPU, so spikes stay visible. */
function downsample(samples: Sample[], target: number): Sample[] {
  if (samples.length <= target) return samples;

  const bucketSize = Math.ceil(samples.length / target);
  const out: Sample[] = [];

  for (let i = 0; i < samples.length; i += bucketSize) {
    const bucket = samples.slice(i, i + bucketSize);
    if (bucket.length === 0) continue;

    const first = bucket[0]!;
    out.push({
      at: first.at,
      cpuPercent: Math.max(...bucket.map((s) => s.cpuPercent)),
      memoryBytes: average(bucket.map((s) => s.memoryBytes)),
      memoryLimitBytes: first.memoryLimitBytes,
      netRxBytes: bucket.at(-1)!.netRxBytes,
      netTxBytes: bucket.at(-1)!.netTxBytes,
      diskBytes: bucket.at(-1)!.diskBytes,
      playersOnline: Math.round(
        bucket.reduce((sum, s) => sum + s.playersOnline, 0) / bucket.length,
      ),
      fps: bucket.some((s) => s.fps !== null)
        ? bucket.filter((s) => s.fps !== null).reduce((sum, s) => sum + (s.fps ?? 0), 0) /
          bucket.filter((s) => s.fps !== null).length
        : null,
    });
  }

  return out;
}

function average(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length);
}

function summarise(samples: Sample[]) {
  if (samples.length === 0) {
    return { avgCpuPercent: 0, peakCpuPercent: 0, avgMemoryBytes: 0, peakPlayers: 0, samples: 0 };
  }
  return {
    avgCpuPercent: Number(
      (samples.reduce((sum, s) => sum + s.cpuPercent, 0) / samples.length).toFixed(2),
    ),
    peakCpuPercent: Number(Math.max(...samples.map((s) => s.cpuPercent)).toFixed(2)),
    avgMemoryBytes: Number(average(samples.map((s) => s.memoryBytes))),
    peakPlayers: Math.max(...samples.map((s) => s.playersOnline)),
    samples: samples.length,
  };
}
