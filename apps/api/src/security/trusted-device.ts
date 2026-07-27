/**
 * Trusted devices — "remember this browser for 14 days".
 *
 * Requiring an authenticator code on every single sign-in is friction people
 * work around, usually by choosing a weaker setup. Remembering a browser they
 * have already proved is the normal trade, provided the limits are real:
 *
 *   * It waives the **second factor only**. The account is still identified,
 *     and an administrator still needs their password.
 *   * It never grants an elevated session, so administrative actions still
 *     require a fresh TOTP step-up.
 *   * The token is opaque, 256-bit, stored only as a SHA-256 digest, and bound
 *     to the browser it was issued to.
 *   * It dies on sign-out-everywhere, password change or TOTP re-enrolment.
 *   * It expires absolutely at 14 days; using it does not extend that.
 */

import { TRUSTED_DEVICE } from '@asp/shared';
import { prisma } from '../db/client.js';
import { generateToken, sha256Hex } from './crypto.js';
import type { ClientIdentity } from './client-identity.js';

export interface IssuedTrustedDevice {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a token for this browser. Oldest entries are pruned so a long-lived
 * account cannot accumulate an unbounded list of standing bypasses.
 */
export async function trustDevice(
  accountId: string,
  client: ClientIdentity,
): Promise<IssuedTrustedDevice> {
  const token = generateToken(TRUSTED_DEVICE.tokenBytes);
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE.ttlMs);

  await prisma.trustedDevice.create({
    data: {
      accountId,
      tokenHash: sha256Hex(token),
      userAgentHash: client.userAgentHash,
      expiresAt,
    },
  });

  const existing = await prisma.trustedDevice.findMany({
    where: { accountId, revokedAt: null },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true },
  });

  if (existing.length > TRUSTED_DEVICE.maxPerAccount) {
    const surplus = existing.slice(TRUSTED_DEVICE.maxPerAccount).map((d) => d.id);
    await prisma.trustedDevice.updateMany({
      where: { id: { in: surplus } },
      data: { revokedAt: new Date(), revokedReason: 'too_many_devices' },
    });
  }

  return { token, expiresAt };
}

/**
 * Checks whether this browser may skip the authenticator for `accountId`.
 *
 * Deliberately strict: any mismatch revokes rather than merely refusing, so a
 * token that has been moved to another browser stops working everywhere.
 */
export async function isDeviceTrusted(
  token: string | undefined,
  accountId: string,
  client: ClientIdentity,
): Promise<boolean> {
  if (!token || token.length < 20 || token.length > 200) return false;

  const device = await prisma.trustedDevice.findUnique({
    where: { tokenHash: sha256Hex(token) },
  });

  if (!device) return false;
  if (device.revokedAt !== null) return false;
  if (device.expiresAt <= new Date()) return false;

  // Presented for a different account, or from a different browser: treat the
  // token as compromised rather than simply unusable here.
  if (device.accountId !== accountId || device.userAgentHash !== client.userAgentHash) {
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), revokedReason: 'binding_mismatch' },
    });
    return false;
  }

  // Records use without extending expiry - 14 days means 14 days.
  await prisma.trustedDevice.update({
    where: { id: device.id },
    data: { lastUsedAt: new Date() },
  });

  return true;
}

export async function revokeDevice(token: string | undefined, reason: string): Promise<void> {
  if (!token) return;
  await prisma.trustedDevice
    .updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    .catch(() => undefined);
}

/** Called on sign-out-everywhere, password change and TOTP re-enrolment. */
export async function revokeAllDevices(accountId: string, reason: string): Promise<number> {
  const result = await prisma.trustedDevice.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function listDevices(accountId: string) {
  return prisma.trustedDevice.findMany({
    where: { accountId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true, lastUsedAt: true, expiresAt: true, createdAt: true },
  });
}

export async function pruneExpiredDevices(): Promise<number> {
  const result = await prisma.trustedDevice.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}
