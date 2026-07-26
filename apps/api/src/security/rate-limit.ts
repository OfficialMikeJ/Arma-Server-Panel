/**
 * Layered rate limiting.
 *
 * Counters live in Postgres (atomic upsert) so limits survive an API restart
 * and hold across a multi-instance deployment. A small in-process LRU absorbs
 * the hot path; it can only ever be *more* strict than the durable counter, so
 * it cannot be used to bypass a limit.
 */

import { prisma } from '../db/client.js';

export interface RateLimitRule {
  points: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
  limit: number;
}

interface LocalEntry {
  count: number;
  expiresAt: number;
}

const local = new Map<string, LocalEntry>();
const LOCAL_MAX_ENTRIES = 20_000;

function pruneLocal(now: number): void {
  if (local.size < LOCAL_MAX_ENTRIES) return;
  for (const [key, entry] of local) {
    if (entry.expiresAt <= now) local.delete(key);
    if (local.size < LOCAL_MAX_ENTRIES * 0.8) break;
  }
  // Still oversized: drop oldest insertions.
  if (local.size >= LOCAL_MAX_ENTRIES) {
    const excess = local.size - Math.floor(LOCAL_MAX_ENTRIES * 0.8);
    let dropped = 0;
    for (const key of local.keys()) {
      local.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Consumes one point from the bucket identified by `key`.
 *
 * `consume: false` inspects the bucket without spending a point, which is how
 * routes report "you are locked out" without deepening the lockout.
 */
export async function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  options: { consume?: boolean; cost?: number } = {},
): Promise<RateLimitResult> {
  const consume = options.consume ?? true;
  const cost = options.cost ?? 1;
  const now = Date.now();

  pruneLocal(now);

  const cached = local.get(key);
  if (cached && cached.expiresAt > now && cached.count >= rule.points) {
    return {
      allowed: false,
      remaining: 0,
      resetMs: cached.expiresAt - now,
      limit: rule.points,
    };
  }

  const expiresAt = new Date(now + rule.windowMs);

  // Single round trip: insert the row, or bump it and roll the window if it
  // has already lapsed. `count` is returned post-increment.
  const rows = await prisma.$queryRaw<Array<{ count: number; expiresAt: Date }>>`
    INSERT INTO rate_counters ("key", "count", "expiresAt")
    VALUES (${key}, ${consume ? cost : 0}, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN rate_counters."expiresAt" <= NOW() THEN ${consume ? cost : 0}
        ELSE rate_counters."count" + ${consume ? cost : 0}
      END,
      "expiresAt" = CASE
        WHEN rate_counters."expiresAt" <= NOW() THEN ${expiresAt}::timestamp
        ELSE rate_counters."expiresAt"
      END
    RETURNING "count", "expiresAt"
  `;

  const row = rows[0];
  if (!row) {
    // Defensive: treat an unexpected empty result as a denial rather than
    // silently allowing unlimited traffic.
    return { allowed: false, remaining: 0, resetMs: rule.windowMs, limit: rule.points };
  }

  const resetMs = Math.max(0, row.expiresAt.getTime() - now);
  const allowed = row.count <= rule.points;

  local.set(key, { count: row.count, expiresAt: row.expiresAt.getTime() });

  return {
    allowed,
    remaining: Math.max(0, rule.points - row.count),
    resetMs,
    limit: rule.points,
  };
}

/** Clears a bucket, e.g. after a successful login. */
export async function resetRateLimit(key: string): Promise<void> {
  local.delete(key);
  await prisma.rateCounter.deleteMany({ where: { key } }).catch(() => undefined);
}

/** Housekeeping; runs on the scheduler. */
export async function pruneExpiredRateCounters(): Promise<number> {
  const result = await prisma.rateCounter.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

export function buildKey(scope: string, ...parts: string[]): string {
  return `${scope}:${parts.join(':')}`;
}
