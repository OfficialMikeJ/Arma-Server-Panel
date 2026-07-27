/**
 * Single-use recovery codes.
 *
 * These are the only way back in if an authenticator is lost, so they are
 * treated exactly like passwords: Argon2id-hashed, shown once, and burned on
 * use inside the same transaction that consumes them.
 */

import { TOTP } from '@asp/shared';
import { secureRandomInt } from './crypto.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Sixteen digits, grouped as 0000-0000-0000-0000.
 *
 * Numeric-only so they can be read off a screen, typed on a phone keypad, and
 * dictated over the phone without "was that a B or an 8".
 *
 * 10^16 is about 2^53. That is less raw entropy than a base32 code of the same
 * length, but these are Argon2id-hashed, single-use, and guarded by the same
 * rate limit as TOTP (6 attempts per 5 minutes). Guessing one is not a viable
 * attack; losing the paper they are written on is the real risk, and legible
 * codes help with that far more than four extra bits.
 */
function formatCode(): string {
  let digits = '';
  while (digits.length < 16) {
    // Rejection-sampled per digit, so there is no modulo bias.
    digits += String(secureRandomInt(10));
  }
  return (digits.match(/.{4}/g) ?? []).join('-');
}

export interface GeneratedRecoveryCodes {
  /** Plaintext, displayed to the operator exactly once. */
  plaintext: string[];
  /** Argon2id hashes, safe to persist. */
  hashes: string[];
}

export async function generateRecoveryCodes(
  count: number = TOTP.recoveryCodeCount,
): Promise<GeneratedRecoveryCodes> {
  const plaintext: string[] = [];
  for (let i = 0; i < count; i += 1) {
    plaintext.push(formatCode());
  }
  const hashes = await Promise.all(plaintext.map((code) => hashPassword(normalizeCode(code))));
  return { plaintext, hashes };
}

/** Strips grouping so hyphens, spaces or neither all compare equal. */
export function normalizeCode(code: string): string {
  return code.trim().replace(/\D/g, '');
}

/**
 * Checks a submitted code against every stored hash. Always tests all of them
 * so the time taken does not reveal how many codes remain.
 */
export async function findMatchingRecoveryCode(
  submitted: string,
  stored: Array<{ id: string; codeHash: string; usedAt: Date | null }>,
): Promise<string | null> {
  const normalized = normalizeCode(submitted);
  if (normalized.length !== 16) return null;

  let matchId: string | null = null;
  for (const entry of stored) {
    const matches = await verifyPassword(entry.codeHash, normalized);
    if (matches && entry.usedAt === null && matchId === null) {
      matchId = entry.id;
    }
  }
  return matchId;
}
