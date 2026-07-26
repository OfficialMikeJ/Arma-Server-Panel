/**
 * RFC 6238 TOTP.
 *
 * Implemented directly rather than pulled from a dependency so the verification
 * path is auditable end to end. Two properties matter beyond correctness:
 *
 *   1. Comparison is constant-time.
 *   2. Every accepted code's time-step is recorded, and any step at or below
 *      the recorded one is refused. Without this, a code observed over the
 *      shoulder (or captured by a phishing proxy) is replayable for its full
 *      30-second window.
 */

import { createHmac } from 'node:crypto';
import { TOTP } from '@asp/shared';
import { base32Decode, base32Encode, randomBytes, safeEqual } from './crypto.js';

export interface TotpSecret {
  /** Raw secret bytes, to be encrypted before storage. */
  raw: Buffer;
  /** Base32 form for manual entry into an authenticator app. */
  base32: string;
}

export function generateTotpSecret(): TotpSecret {
  const raw = randomBytes(TOTP.secretBytes);
  return { raw, base32: base32Encode(raw) };
}

export function currentStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP.periodSeconds);
}

function computeCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', secret).update(counter).digest();
  // Dynamic truncation, RFC 4226 section 5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** TOTP.digits).toString().padStart(TOTP.digits, '0');
}

export interface TotpVerifyResult {
  valid: boolean;
  /** The step the code belonged to. Persist this to block replay. */
  step: number | null;
  reason?: 'malformed' | 'replayed' | 'mismatch';
}

/**
 * @param lastAcceptedStep The highest step previously accepted for this account.
 *                         Pass null for a first-time enrolment.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  lastAcceptedStep: number | null,
  atMs: number = Date.now(),
): TotpVerifyResult {
  const normalized = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP.digits}}$`).test(normalized)) {
    return { valid: false, step: null, reason: 'malformed' };
  }

  const now = currentStep(atMs);

  // Walk the whole window every time so verification cost does not depend on
  // which step matched.
  let matchedStep: number | null = null;
  for (let delta = -TOTP.windowSteps; delta <= TOTP.windowSteps; delta += 1) {
    const step = now + delta;
    const expected = computeCode(secret, step);
    if (safeEqual(expected, normalized)) {
      matchedStep = step;
    }
  }

  if (matchedStep === null) {
    return { valid: false, step: null, reason: 'mismatch' };
  }

  if (lastAcceptedStep !== null && matchedStep <= lastAcceptedStep) {
    return { valid: false, step: matchedStep, reason: 'replayed' };
  }

  return { valid: true, step: matchedStep };
}

/** otpauth:// URI for the enrolment QR code. */
export function buildOtpAuthUri(params: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = params.issuer ?? TOTP.issuer;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: TOTP.algorithm,
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export { base32Decode };
