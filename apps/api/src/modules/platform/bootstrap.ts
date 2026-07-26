/**
 * Bootstrap administrator.
 *
 * Runs on every API start, not from a seed script. A seed invoked by a shell
 * entrypoint can fail silently and leave the panel with no way in; doing it
 * here means a failure is a startup error with a stack trace, and the
 * behaviour is identical whether the stack was started by compose, by a
 * process supervisor, or by hand.
 *
 * Idempotent by construction: it does nothing at all once any administrator
 * account exists, so it can never resurrect the default credential on an
 * account that has already been secured.
 */

import { canonicalizeUsername } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { hashPassword } from '../../security/password.js';
import { logger } from '../../lib/logger.js';

const BOOTSTRAP_USERNAME = 'Admin';
const BOOTSTRAP_PASSWORD = 'Password123';

export async function ensureBootstrapAdmin(): Promise<void> {
  const existing = await prisma.account.findFirst({
    where: { type: 'ADMIN', deletedAt: null },
    select: { id: true, username: true, mustChangePassword: true, totpVerified: true },
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    if (existing.mustChangePassword || !existing.totpVerified) {
      logger.warn(
        {
          username: existing.username,
          passwordChangeRequired: existing.mustChangePassword,
          totpRequired: !existing.totpVerified,
        },
        'Administrator account is not yet secured. Do not expose this panel to the internet.',
      );
      printBanner(existing.username, existing.mustChangePassword);
    }
    return;
  }

  const passwordHash = await hashPassword(BOOTSTRAP_PASSWORD);

  await prisma.account.create({
    data: {
      type: 'ADMIN',
      // Not ACTIVE: no feature route is reachable until TOTP is enrolled.
      status: 'PENDING_TOTP',
      username: BOOTSTRAP_USERNAME,
      canonicalUsername: canonicalizeUsername(BOOTSTRAP_USERNAME),
      passwordHash,
      mustChangePassword: true,
      totpVerified: false,
      isPlatformOwner: true,
    },
  });

  logger.info('Created the bootstrap administrator account.');
  printBanner(BOOTSTRAP_USERNAME, true);
}

function printBanner(username: string, defaultPasswordActive: boolean): void {
  const lines = [
    '',
    '='.repeat(64),
    '  ARMA SERVER PANEL - FIRST LOGIN',
    '',
    `    Username:  ${username}`,
    defaultPasswordActive ? `    Password:  ${BOOTSTRAP_PASSWORD}` : '    Password:  (already changed)',
    '',
    '  Choose "Administrator" on the sign-in page, not "Member".',
    '',
    '  You will be forced to change this password, then to enrol an',
    '  authenticator app. Until both are done the account cannot manage',
    '  servers, read consoles, or create API keys.',
    '='.repeat(64),
    '',
  ];
  // Written straight to stdout so it survives log-level filtering and is
  // readable in `docker compose logs`.
  process.stdout.write(lines.join('\n') + '\n');
}
