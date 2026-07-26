/**
 * First-run seed.
 *
 * Creates the single bootstrap administrator the spec calls for
 * (Admin / Password123) in a state where it can do exactly two things:
 * change its password and enrol TOTP. Everything else is refused by
 * `requireActiveAccount` until both are done.
 *
 * Re-running this is safe: it will not resurrect the default credential on an
 * account whose password has already been changed.
 */

import { PrismaClient } from '@prisma/client';
import { hash as argon2Hash } from '@node-rs/argon2';
import { canonicalizeUsername } from '@asp/shared';

const prisma = new PrismaClient();

const BOOTSTRAP_USERNAME = 'Admin';
const BOOTSTRAP_PASSWORD = 'Password123';

const ARGON2ID = 2;
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 47104,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

async function main(): Promise<void> {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  const canonical = canonicalizeUsername(BOOTSTRAP_USERNAME);
  const existing = await prisma.account.findUnique({ where: { canonicalUsername: canonical } });

  if (existing) {
    if (existing.mustChangePassword) {
      console.log('Bootstrap administrator already exists and has not been secured yet.');
      printInstructions();
    } else {
      console.log('Administrator account already exists and has been secured. Nothing to do.');
    }
    return;
  }

  const passwordHash = await argon2Hash(BOOTSTRAP_PASSWORD, ARGON2_OPTIONS);

  await prisma.account.create({
    data: {
      type: 'ADMIN',
      // Not ACTIVE: the account cannot reach any feature route until TOTP is
      // enrolled, which flips this to ACTIVE.
      status: 'PENDING_TOTP',
      username: BOOTSTRAP_USERNAME,
      canonicalUsername: canonical,
      passwordHash,
      mustChangePassword: true,
      totpVerified: false,
      isPlatformOwner: true,
    },
  });

  console.log('Created the bootstrap administrator account.');
  printInstructions();
}

function printInstructions(): void {
  console.log(`
────────────────────────────────────────────────────────────────
  FIRST LOGIN

    Username:  ${BOOTSTRAP_USERNAME}
    Password:  ${BOOTSTRAP_PASSWORD}

  You will be forced to change this password immediately, and then
  to enrol an authenticator app. Until both are done the account
  cannot manage servers, read consoles, or create API keys.

  The moment the password is changed, this default credential is
  retired permanently and cannot be re-enabled.

  Do not expose the panel to the internet before completing both
  steps.
────────────────────────────────────────────────────────────────
`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
