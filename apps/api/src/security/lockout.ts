/**
 * Progressive account lockout.
 *
 * Distinct from rate limiting: rate limits are per-client, lockouts are
 * per-account. Both must be satisfied, so an attacker cannot spread a
 * credential-stuffing run across many IPs to defeat the per-IP limit.
 */

import { LOCKOUT } from '@asp/shared';
import { prisma } from '../db/client.js';

export interface LockoutState {
  locked: boolean;
  until: Date | null;
  failures: number;
}

export function computeLockDuration(failures: number): number {
  let duration = 0;
  for (const threshold of LOCKOUT.thresholds) {
    if (failures >= threshold.failures) duration = threshold.lockMs;
  }
  return duration;
}

export async function getLockoutState(accountId: string): Promise<LockoutState> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { failedAuthCount: true, lockedUntil: true, lastFailedAuthAt: true },
  });
  if (!account) return { locked: false, until: null, failures: 0 };

  const now = new Date();

  // Counter decays after a quiet period so a legitimate user is not punished
  // for a mistake made months ago.
  const decayed =
    account.lastFailedAuthAt !== null &&
    now.getTime() - account.lastFailedAuthAt.getTime() > LOCKOUT.decayMs;

  const failures = decayed ? 0 : account.failedAuthCount;
  const locked = account.lockedUntil !== null && account.lockedUntil > now;

  return { locked, until: locked ? account.lockedUntil : null, failures };
}

export async function recordAuthFailure(accountId: string): Promise<LockoutState> {
  const now = new Date();
  const existing = await prisma.account.findUnique({
    where: { id: accountId },
    select: { failedAuthCount: true, lastFailedAuthAt: true },
  });

  const decayed =
    existing?.lastFailedAuthAt != null &&
    now.getTime() - existing.lastFailedAuthAt.getTime() > LOCKOUT.decayMs;

  const failures = (decayed ? 0 : existing?.failedAuthCount ?? 0) + 1;
  const lockMs = computeLockDuration(failures);
  const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;

  await prisma.account.update({
    where: { id: accountId },
    data: {
      failedAuthCount: failures,
      lastFailedAuthAt: now,
      lockedUntil,
    },
  });

  return { locked: lockedUntil !== null, until: lockedUntil, failures };
}

export async function clearAuthFailures(accountId: string): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: { failedAuthCount: 0, lockedUntil: null, lastFailedAuthAt: null },
  });
}
