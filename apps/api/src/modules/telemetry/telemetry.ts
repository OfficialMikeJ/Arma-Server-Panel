/**
 * Anonymous usage reporting.
 *
 * Powers the counters on the project website: how many panels are deployed,
 * how many are currently running, and how many game servers they run between
 * them.
 *
 * Design rules, in order of importance:
 *   1. Off unless the operator turned it on. The installer asks in plain words.
 *   2. The instance id is random bytes generated on first boot. It is not
 *      derived from a hostname, MAC address, IP, licence or anything else that
 *      could tie it back to a person or machine.
 *   3. Only counts leave the host. No server names, player counts per server,
 *      addresses, usernames, mod lists or configuration.
 *   4. It uses the same SSRF-guarded egress as every other outbound request,
 *      so a hostile TELEMETRY_ENDPOINT cannot be pointed at a LAN service.
 *   5. Failure is silent and never retried aggressively. Reporting must never
 *      affect whether the panel works.
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { safeFetch } from '../../security/ssrf.js';
import { getPlatformSettings } from '../platform/platform-settings.js';

/** Bumped with the panel; lets the site show version adoption. */
export const PANEL_VERSION = '1.0.0';

const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface TelemetryPayload {
  instanceId: string;
  version: string;
  /** Coarse only - "linux", never a kernel build or hostname. */
  platform: string;
  /** Total game servers configured on this panel. */
  serverCount: number;
  /** Of those, how many are currently running. */
  runningServerCount: number;
  /** Per-title counts, so the site can show which games are actually used. */
  games: Record<string, number>;
  nodeCount: number;
  /** Whole days, rounded down. Not a precise install timestamp. */
  uptimeDays: number;
}

/** Creates the instance id on first use. */
async function getInstanceId(): Promise<string> {
  const settings = await getPlatformSettings();
  if (settings.telemetryInstanceId) return settings.telemetryInstanceId;

  const instanceId = randomBytes(16).toString('hex');
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { telemetryInstanceId: instanceId },
  });
  return instanceId;
}

export async function collectPayload(): Promise<TelemetryPayload> {
  const settings = await getPlatformSettings();

  const [servers, running, nodeCount] = await Promise.all([
    prisma.server.groupBy({
      by: ['game'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
    prisma.server.count({ where: { deletedAt: null, state: 'RUNNING' } }),
    prisma.node.count(),
  ]);

  const games: Record<string, number> = {};
  let serverCount = 0;
  for (const row of servers) {
    const key = row.game.toLowerCase();
    games[key] = row._count._all;
    serverCount += row._count._all;
  }

  return {
    instanceId: await getInstanceId(),
    version: PANEL_VERSION,
    platform: process.platform,
    serverCount,
    runningServerCount: running,
    games,
    nodeCount,
    uptimeDays: Math.floor(
      (Date.now() - settings.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    ),
  };
}

/** Sends one report. Returns false on any failure, without throwing. */
export async function sendReport(): Promise<boolean> {
  const config = loadConfig();
  if (!config.TELEMETRY_ENABLED) return false;

  try {
    const payload = await collectPayload();

    const response = await safeFetch(config.TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 10_000,
      maxResponseBytes: 8 * 1024,
    });

    if (response.status >= 400) {
      logger.debug({ status: response.status }, 'Telemetry endpoint rejected the report');
      return false;
    }

    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { telemetryLastSentAt: new Date() },
    });

    logger.debug('Telemetry report sent');
    return true;
  } catch (error) {
    // Never surfaced to the operator and never retried in a tight loop.
    logger.debug({ err: error }, 'Telemetry report failed');
    return false;
  }
}

/** Called by the scheduler. No-ops when disabled or when it reported recently. */
export async function reportIfDue(): Promise<boolean> {
  const config = loadConfig();
  if (!config.TELEMETRY_ENABLED) return false;

  const settings = await getPlatformSettings();
  const last = settings.telemetryLastSentAt?.getTime() ?? 0;
  if (Date.now() - last < REPORT_INTERVAL_MS) return false;

  return sendReport();
}

/**
 * Exactly what would be transmitted, for the operator to inspect before
 * deciding. Surfaced in the panel's privacy screen.
 */
export async function previewPayload(): Promise<{
  enabled: boolean;
  endpoint: string;
  payload: TelemetryPayload;
}> {
  const config = loadConfig();
  return {
    enabled: config.TELEMETRY_ENABLED,
    endpoint: config.TELEMETRY_ENDPOINT,
    payload: await collectPayload(),
  };
}
