/**
 * Background housekeeping.
 *
 * Deliberately a plain interval scheduler rather than a job queue: every task
 * here is idempotent, cheap, and safe to skip. Each run is wrapped so one
 * failing task cannot stop the others.
 */

import { CONSOLE_LIMITS, METRICS, AUDIT } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { pruneExpiredSessions } from '../../security/session.js';
import { pruneExpiredRateCounters } from '../../security/rate-limit.js';
import { pruneExpiredChallenges } from '../auth/challenges.js';
import { pruneUsernameAttempts } from '../auth/username-policy.js';
import { renewExpiringMappings } from '../network/port-forwarder.js';
import { refreshHostRequirements } from '../host/host-requirements.js';
import { reportIfDue } from '../telemetry/telemetry.js';

interface Task {
  name: string;
  intervalMs: number;
  run: () => Promise<number | void>;
  lastRun: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const tasks: Task[] = [
  {
    name: 'renew-port-leases',
    // UPnP/NAT-PMP leases are typically an hour; renew well inside that.
    intervalMs: 5 * MINUTE,
    lastRun: 0,
    run: renewExpiringMappings,
  },
  {
    name: 'prune-sessions',
    intervalMs: 15 * MINUTE,
    lastRun: 0,
    run: pruneExpiredSessions,
  },
  {
    name: 'prune-challenges',
    intervalMs: 10 * MINUTE,
    lastRun: 0,
    run: pruneExpiredChallenges,
  },
  {
    name: 'prune-rate-counters',
    intervalMs: 10 * MINUTE,
    lastRun: 0,
    run: pruneExpiredRateCounters,
  },
  {
    name: 'prune-username-attempts',
    intervalMs: HOUR,
    lastRun: 0,
    run: pruneUsernameAttempts,
  },
  {
    name: 'prune-console-lines',
    intervalMs: HOUR,
    lastRun: 0,
    async run() {
      const cutoff = new Date(Date.now() - CONSOLE_LIMITS.retentionDays * 24 * HOUR);
      const result = await prisma.consoleLine.deleteMany({ where: { at: { lt: cutoff } } });
      return result.count;
    },
  },
  {
    name: 'rollup-metrics',
    intervalMs: 30 * MINUTE,
    lastRun: 0,
    async run() {
      // Collapse raw samples older than the raw window into one-minute buckets,
      // so 30 days of graphs stay queryable without unbounded growth.
      const cutoff = new Date(Date.now() - METRICS.rawRetentionMs);
      const rolled = await prisma.$executeRaw`
        INSERT INTO metric_samples
          ("serverId", "at", "bucketSeconds", "cpuPercent", "memoryBytes",
           "memoryLimitBytes", "diskBytes", "netRxBytes", "netTxBytes", "playersOnline", "fps")
        SELECT
          "serverId",
          date_trunc('minute', "at") AS bucket,
          60,
          AVG("cpuPercent"),
          AVG("memoryBytes")::bigint,
          MAX("memoryLimitBytes"),
          MAX("diskBytes"),
          MAX("netRxBytes"),
          MAX("netTxBytes"),
          ROUND(AVG("playersOnline"))::int,
          AVG("fps")
        FROM metric_samples
        WHERE "at" < ${cutoff} AND "bucketSeconds" IS NULL
        GROUP BY "serverId", date_trunc('minute', "at")
        ON CONFLICT DO NOTHING
      `;

      await prisma.metricSample.deleteMany({
        where: { at: { lt: cutoff }, bucketSeconds: null },
      });

      const oldCutoff = new Date(Date.now() - METRICS.rolledRetentionMs);
      await prisma.metricSample.deleteMany({ where: { at: { lt: oldCutoff } } });

      return rolled;
    },
  },
  {
    name: 'prune-audit',
    intervalMs: 12 * HOUR,
    lastRun: 0,
    async run() {
      const cutoff = new Date(Date.now() - AUDIT.retentionDays * 24 * HOUR);
      // Chain integrity is only verifiable forward from the oldest retained
      // entry, which is the accepted trade for bounded storage.
      const result = await prisma.auditLog.deleteMany({ where: { at: { lt: cutoff } } });
      return result.count;
    },
  },
  {
    name: 'refresh-host-requirements',
    intervalMs: 6 * HOUR,
    lastRun: 0,
    async run() {
      const report = await refreshHostRequirements({ runSpeedTest: true });
      if (!report.pass) {
        logger.warn(
          { failing: report.checks.filter((c) => !c.pass).map((c) => c.key) },
          'Host requirements check is failing - registration is closed',
        );
      }
    },
  },
  {
    name: 'telemetry-report',
    // Checked hourly, but the module itself only sends every six hours.
    intervalMs: HOUR,
    lastRun: 0,
    async run() {
      await reportIfDue();
    },
  },
  {
    name: 'reset-monthly-bandwidth',
    intervalMs: HOUR,
    lastRun: 0,
    async run() {
      // Lift suspensions that were applied purely for a transfer quota once a
      // new accounting month has begun.
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const suspended = await prisma.server.findMany({
        where: {
          suspended: true,
          suspendReason: { contains: 'transfer quota' },
          deletedAt: null,
        },
        select: { id: true },
      });

      let lifted = 0;
      for (const server of suspended) {
        const usage = await prisma.bandwidthUsage.findUnique({
          where: { serverId_periodStart: { serverId: server.id, periodStart } },
        });
        if (!usage) {
          await prisma.server.update({
            where: { id: server.id },
            data: { suspended: false, suspendReason: null },
          });
          lifted += 1;
        }
      }
      return lifted;
    },
  },
];

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;

  timer = setInterval(() => {
    const now = Date.now();
    for (const task of tasks) {
      if (now - task.lastRun < task.intervalMs) continue;
      task.lastRun = now;

      void task
        .run()
        .then((count) => {
          if (typeof count === 'number' && count > 0) {
            logger.debug({ task: task.name, count }, 'Scheduled task complete');
          }
        })
        .catch((error) => {
          logger.error({ err: error, task: task.name }, 'Scheduled task failed');
        });
    }
  }, 30_000);

  timer.unref();
  logger.info({ tasks: tasks.length }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test/ops helper: run one task immediately by name. */
export async function runTaskNow(name: string): Promise<number | void> {
  const task = tasks.find((t) => t.name === name);
  if (!task) throw new Error(`Unknown task "${name}"`);
  task.lastRun = Date.now();
  return task.run();
}

export function listTasks(): Array<{ name: string; intervalMs: number; lastRun: number }> {
  return tasks.map(({ name, intervalMs, lastRun }) => ({ name, intervalMs, lastRun }));
}
