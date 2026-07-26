/**
 * Short-lived, single-use tokens for the multi-step auth flows.
 *
 * A challenge is consumed atomically (`updateMany` with `consumedAt: null` in
 * the predicate), so two concurrent requests carrying the same token cannot
 * both succeed.
 */

import type { ChallengeKind } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { generateToken, sha256Hex, encryptSecret, decryptSecretToString } from '../../security/crypto.js';

export interface IssuedChallenge {
  /** Raw token handed to the client. Only the digest is stored. */
  token: string;
  id: string;
  expiresAt: Date;
}

export async function issueChallenge(params: {
  kind: ChallengeKind;
  accountId?: string | null;
  payload?: Record<string, unknown>;
  ttlMs: number;
  maxAttempts?: number;
}): Promise<IssuedChallenge> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + params.ttlMs);

  const record = await prisma.authChallenge.create({
    data: {
      kind: params.kind,
      tokenHash: sha256Hex(token),
      accountId: params.accountId ?? null,
      payloadEnc: params.payload
        ? encryptSecret(JSON.stringify(params.payload), 'challenge-payload')
        : null,
      maxAttempts: params.maxAttempts ?? 5,
      expiresAt,
    },
  });

  return { token, id: record.id, expiresAt };
}

export type ChallengeFailure = 'not_found' | 'expired' | 'consumed' | 'too_many_attempts' | 'wrong_kind';

export interface ChallengeLookup<T = Record<string, unknown>> {
  ok: boolean;
  reason?: ChallengeFailure;
  challenge?: {
    id: string;
    accountId: string | null;
    payload: T | null;
    attempts: number;
    maxAttempts: number;
  };
}

/** Reads a challenge without consuming it. Used before verifying a code. */
export async function peekChallenge<T = Record<string, unknown>>(
  token: string,
  kind: ChallengeKind,
): Promise<ChallengeLookup<T>> {
  if (!token || token.length < 16 || token.length > 256) return { ok: false, reason: 'not_found' };

  const record = await prisma.authChallenge.findUnique({
    where: { tokenHash: sha256Hex(token) },
  });

  if (!record) return { ok: false, reason: 'not_found' };
  if (record.kind !== kind) return { ok: false, reason: 'wrong_kind' };
  if (record.consumedAt !== null) return { ok: false, reason: 'consumed' };
  if (record.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
  if (record.attempts >= record.maxAttempts) return { ok: false, reason: 'too_many_attempts' };

  let payload: T | null = null;
  if (record.payloadEnc) {
    payload = JSON.parse(decryptSecretToString(record.payloadEnc, 'challenge-payload')) as T;
  }

  return {
    ok: true,
    challenge: {
      id: record.id,
      accountId: record.accountId,
      payload,
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
    },
  };
}

/** Records a failed verification attempt against a challenge. */
export async function recordChallengeAttempt(challengeId: string): Promise<number> {
  const updated = await prisma.authChallenge.update({
    where: { id: challengeId },
    data: { attempts: { increment: 1 } },
    select: { attempts: true, maxAttempts: true },
  });
  return updated.maxAttempts - updated.attempts;
}

/**
 * Marks a challenge used. Returns false if it was already consumed, which is
 * how a replayed token is detected.
 */
export async function consumeChallenge(challengeId: string): Promise<boolean> {
  const result = await prisma.authChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}

export async function pruneExpiredChallenges(): Promise<number> {
  const result = await prisma.authChallenge.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { consumedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}

export const CHALLENGE_TTL = {
  totpEnrollment: 15 * 60 * 1000,
  loginTotp: 5 * 60 * 1000,
  discordLink: 10 * 60 * 1000,
  adminStepUp: 5 * 60 * 1000,
} as const;
