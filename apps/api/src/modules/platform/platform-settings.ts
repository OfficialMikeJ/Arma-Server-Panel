import type { PlatformSettings, Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';

/** The settings table holds exactly one row, with id = 1. */
export async function ensurePlatformSettings(): Promise<PlatformSettings> {
  return prisma.platformSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const existing = await prisma.platformSettings.findUnique({ where: { id: 1 } });
  return existing ?? ensurePlatformSettings();
}

export async function updatePlatformSettings(
  data: Prisma.PlatformSettingsUpdateInput,
): Promise<PlatformSettings> {
  return prisma.platformSettings.update({ where: { id: 1 }, data });
}

/**
 * Registration is only open when *all* of these hold:
 *   * setup has completed,
 *   * the host still satisfies the hard-coded minimum requirements,
 *   * the operator has not closed registration.
 */
export async function isRegistrationOpen(): Promise<{ open: boolean; reason?: string }> {
  const settings = await getPlatformSettings();

  if (!settings.setupComplete) {
    return { open: false, reason: 'The panel has not finished first-run setup yet.' };
  }
  if (!settings.requirementsPass) {
    return {
      open: false,
      reason: 'This host does not meet the minimum requirements, so registration is closed.',
    };
  }
  if (!settings.registrationOpen) {
    return { open: false, reason: 'Registration is currently closed.' };
  }
  return { open: true };
}
