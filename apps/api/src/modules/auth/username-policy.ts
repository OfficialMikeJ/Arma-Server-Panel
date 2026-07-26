/**
 * Username screening and the warn-then-ban abuse rule.
 *
 * Spec: an unacceptable username triggers a warning the first time. If the
 * *same* username is submitted again, the client is banned from registering
 * for two hours.
 *
 * Implementation notes:
 *   * "Same username" is compared on the screening-normalised form, so
 *     `Sh1tlord` and `shitlord` count as the same attempt. Otherwise the rule
 *     would be trivially bypassed by changing one character.
 *   * Only *abusive* rejections (offensive, impersonation, confusable) count
 *     toward the ban. Someone whose name is merely too short or already taken
 *     is not being abusive and is not punished.
 *   * The client key is a peppered hash of the IP, plus the Discord id when
 *     one is present, so a signed-in abuser cannot simply change networks.
 */

import {
  USERNAME_POLICY,
  checkUsername,
  isAbusiveRejection,
  type UsernameCheckResult,
} from '@asp/shared';
import type { UsernameAttemptOutcome } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { audit, AuditAction } from '../../security/audit.js';
import { buildKey, consumeRateLimit } from '../../security/rate-limit.js';

export interface UsernameScreenContext {
  clientHash: string;
  ipHash: string;
  userAgentHash: string;
  /** Discord id when the registration is being linked from OAuth. */
  externalId?: string | null;
}

export type UsernameScreenStatus =
  | 'accepted'
  | 'rejected'
  | 'warned'
  | 'banned'
  | 'rate_limited'
  | 'already_banned';

export interface UsernameScreenResult {
  status: UsernameScreenStatus;
  check: UsernameCheckResult;
  message: string;
  /** Set when the client is banned; milliseconds until they may retry. */
  retryAfterMs?: number;
  /** True on the one-and-only warning, so the UI can say "final warning". */
  isFinalWarning?: boolean;
}

/** Returns the active ban for a client, if any. */
export async function getActiveBan(clientHash: string) {
  return prisma.registrationBan.findFirst({
    where: { clientHash, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
  });
}

export async function screenUsername(
  raw: string,
  context: UsernameScreenContext,
): Promise<UsernameScreenResult> {
  const check = checkUsername(raw);

  // 0. Already banned? Nothing else matters.
  const existingBan = await getActiveBan(context.clientHash);
  if (existingBan) {
    return {
      status: 'already_banned',
      check,
      message:
        'Registration from this connection is temporarily blocked because of an unacceptable username.',
      retryAfterMs: existingBan.expiresAt.getTime() - Date.now(),
    };
  }

  // 1. Rate limit how fast usernames can be tried at all.
  const limit = await consumeRateLimit(
    buildKey('username-try', context.clientHash.slice(0, 32)),
    USERNAME_POLICY.rateLimit,
  );
  if (!limit.allowed) {
    return {
      status: 'rate_limited',
      check,
      message: 'Too many username attempts. Please wait a moment and try again.',
      retryAfterMs: limit.resetMs,
    };
  }

  // 2. Policy check passed - make sure it is not already taken.
  if (check.ok) {
    const taken = await prisma.account.findFirst({
      where: { canonicalUsername: check.canonical, deletedAt: null },
      select: { id: true },
    });

    if (taken) {
      await recordAttempt(context, check, 'REJECTED_TAKEN', 'taken', false);
      return {
        status: 'rejected',
        check: { ...check, ok: false, reason: 'taken' },
        message: 'That username is already taken.',
      };
    }

    await recordAttempt(context, check, 'ACCEPTED', null, false);
    return { status: 'accepted', check, message: 'Username is available.' };
  }

  // 3. Rejected for a non-abusive reason: tell them why, no penalty.
  if (!isAbusiveRejection(check.reason)) {
    await recordAttempt(context, check, 'REJECTED_POLICY', check.reason ?? null, false);
    return {
      status: 'rejected',
      check,
      message: check.message ?? 'That username cannot be used.',
    };
  }

  // 4. Abusive. Has this exact (normalised) name already been warned about?
  const since = new Date(Date.now() - USERNAME_POLICY.warningRetentionMs);
  const priorWarning = await prisma.usernameAttempt.findFirst({
    where: {
      clientHash: context.clientHash,
      normalized: check.normalized,
      outcome: 'REJECTED_ABUSIVE',
      warned: true,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!priorWarning) {
    // First offence: warn.
    await recordAttempt(context, check, 'REJECTED_ABUSIVE', check.reason ?? null, true);
    await audit({
      actorLabel: 'anonymous',
      action: AuditAction.UsernameRejected,
      outcome: 'denied',
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { reason: check.reason, normalized: check.normalized, warned: true },
    });

    return {
      status: 'warned',
      check,
      isFinalWarning: true,
      message:
        'That username is not acceptable. This is a warning: submitting it again will block ' +
        'registration from this connection for 2 hours.',
    };
  }

  // 5. Second offence with the same name: ban.
  const expiresAt = new Date(Date.now() + USERNAME_POLICY.banDurationMs);
  await prisma.$transaction([
    prisma.usernameAttempt.create({
      data: {
        clientHash: context.clientHash,
        normalized: check.normalized,
        rawUsername: raw.slice(0, 64),
        outcome: 'REJECTED_ABUSIVE',
        reason: check.reason ?? null,
        warned: false,
      },
    }),
    prisma.registrationBan.create({
      data: {
        clientHash: context.clientHash,
        reason: `Repeated unacceptable username (${check.reason})`,
        trigger: check.normalized,
        expiresAt,
      },
    }),
  ]);

  await audit({
    actorLabel: 'anonymous',
    action: AuditAction.UsernameBanIssued,
    outcome: 'denied',
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: {
      reason: check.reason,
      normalized: check.normalized,
      banMinutes: USERNAME_POLICY.banDurationMs / 60_000,
    },
  });

  return {
    status: 'banned',
    check,
    retryAfterMs: USERNAME_POLICY.banDurationMs,
    message:
      'You were warned. Registration from this connection is now blocked for 2 hours.',
  };
}

async function recordAttempt(
  context: UsernameScreenContext,
  check: UsernameCheckResult,
  outcome: UsernameAttemptOutcome,
  reason: string | null,
  warned: boolean,
): Promise<void> {
  await prisma.usernameAttempt.create({
    data: {
      clientHash: context.clientHash,
      normalized: check.normalized,
      // Truncated; retained only for the abuse audit trail.
      rawUsername: check.canonical.slice(0, 64),
      outcome,
      reason,
      warned,
    },
  });
}

/** Housekeeping - attempts are only needed for the warning-retention window. */
export async function pruneUsernameAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - USERNAME_POLICY.warningRetentionMs);
  const [attempts, bans] = await Promise.all([
    prisma.usernameAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.registrationBan.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
  ]);
  return attempts.count + bans.count;
}
