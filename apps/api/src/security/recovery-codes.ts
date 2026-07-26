/**
 * Single-use recovery codes.
 *
 * These are the only way back in if an authenticator is lost, so they are
 * treated exactly like passwords: Argon2id-hashed, shown once, and burned on
 * use inside the same transaction that consumes them.
 */

import { TOTP } from '@asp/shared';
import { base32Encode, randomBytes } from './crypto.js';
import { hashPassword, verifyPassword } from './password.js';

/** Formats 20 base32 characters as XXXX-XXXX-XXXX-XXXX. */
function formatCode(raw: Buffer): string {
  const encoded = base32Encode(raw).slice(0, 16);
  return (encoded.match(/.{4}/g) ?? []).join('-');
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
    plaintext.push(formatCode(randomBytes(TOTP.recoveryCodeBytes)));
  }
  const hashes = await Promise.all(plaintext.map((code) => hashPassword(normalizeCode(code))));
  return { plaintext, hashes };
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
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
