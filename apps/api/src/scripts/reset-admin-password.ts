/**
 * Administrator recovery.
 *
 *   docker compose exec api node dist/scripts/reset-admin-password.js
 *
 * Issues a strong temporary password and forces the normal change-password
 * flow on next sign-in, so the temporary value is never a lasting credential.
 *
 * Options:
 *   --username <name>   which admin to reset (default: the first one)
 *   --reset-2fa         also clear the authenticator, if it was lost too
 *
 * Why this is safe to ship: it requires shell access to the API container,
 * which already implies control of the host and the encryption key. It grants
 * nothing an attacker at that level does not already have. Every run is
 * written to the audit log.
 */

import { canonicalizeUsername } from '@asp/shared';
import { prisma } from '../db/client.js';
import { hashPassword } from '../security/password.js';
import { generateToken } from '../security/crypto.js';
import { revokeAllSessions } from '../security/session.js';
import { audit, AuditAction } from '../security/audit.js';

interface Options {
  username: string | null;
  resetTotp: boolean;
  /** Clear the authenticator but leave the password alone. */
  keepPassword: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { username: null, resetTotp: false, keepPassword: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username' || arg === '-u') {
      options.username = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--reset-2fa') {
      options.resetTotp = true;
    } else if (arg === '--keep-password') {
      options.keepPassword = true;
      // Only useful alongside a 2FA reset - otherwise it does nothing at all.
      options.resetTotp = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Administrator recovery.',
          '',
          '  --username, -u <name>   which admin (default: the first)',
          '  --reset-2fa             clear the authenticator enrolment',
          '  --keep-password         clear 2FA only, leave the password as it is',
          '',
          'Examples:',
          '  # locked out entirely',
          '  node dist/scripts/reset-admin-password.js --reset-2fa',
          '',
          '  # password is fine, just cannot reach the authenticator',
          '  node dist/scripts/reset-admin-password.js --keep-password',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
  }

  return options;
}

/**
 * Readable but strong: 4 groups of 5 base64url characters, ~120 bits. Easy to
 * retype off a terminal without ambiguity about where a group ends.
 */
function temporaryPassword(): string {
  const raw = generateToken(24).replace(/[-_]/g, '');
  return (raw.slice(0, 20).match(/.{5}/g) ?? []).join('-');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const account = options.username
    ? await prisma.account.findFirst({
        where: { canonicalUsername: canonicalizeUsername(options.username), deletedAt: null },
      })
    : await prisma.account.findFirst({
        where: { type: 'ADMIN', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

  if (!account) {
    console.error(
      options.username
        ? `No account found for "${options.username}".`
        : 'No administrator account exists. Restart the API and one will be created.',
    );
    process.exit(1);
  }

  if (account.type !== 'ADMIN') {
    console.error(
      `"${account.username}" is not an administrator. Member accounts have no password - ` +
        'they sign in with an authenticator code, and are recovered with a recovery code.',
    );
    process.exit(1);
  }

  const password = options.keepPassword ? null : temporaryPassword();

  await prisma.account.update({
    where: { id: account.id },
    data: {
      // Always clear the lockout - whatever brought someone to this script,
      // failed attempts should not keep them out afterwards.
      failedAuthCount: 0,
      lockedUntil: null,
      ...(password !== null
        ? {
            passwordHash: await hashPassword(password),
            // The existing forced-change flow takes over from here, so this
            // temporary value cannot become a permanent password.
            mustChangePassword: true,
            passwordChangedAt: null,
          }
        : {}),
      ...(options.resetTotp
        ? {
            totpSecretEnc: null,
            totpVerified: false,
            totpEnrolledAt: null,
            totpLastStep: null,
            status: 'PENDING_TOTP' as const,
          }
        : {}),
    },
  });

  // Anything issued before the reset must stop working.
  const revoked = await revokeAllSessions(account.id, 'password_reset_via_cli');

  if (options.resetTotp) {
    // The old recovery codes belong to the old authenticator.
    await prisma.recoveryCode.deleteMany({ where: { accountId: account.id } });
  }

  await audit({
    accountId: account.id,
    actorLabel: `${account.username} (console)`,
    action: AuditAction.AdminPasswordChanged,
    metadata: { viaCli: true, resetTotp: options.resetTotp, sessionsRevoked: revoked },
  });

  const line = '='.repeat(58);
  console.log(
    [
      '',
      line,
      password !== null ? '  TEMPORARY PASSWORD ISSUED' : '  TWO-FACTOR CLEARED',
      '',
      `    Username:  ${account.username}`,
      password !== null
        ? `    Password:  ${password}`
        : '    Password:  unchanged - use the one you already have',
      '',
      '  Sign in on the "Administrator" tab.',
      password !== null ? '  You will be required to choose a new password immediately.' : '',
      options.resetTotp
        ? '  You will be asked to enrol an authenticator, and will receive\n  a fresh set of recovery codes.'
        : '  Your existing authenticator code is still required.',
      '',
      `  ${revoked} session${revoked === 1 ? '' : 's'} signed out.`,
      line,
      '',
    ]
      .filter((row) => row !== '')
      .join('\n'),
  );
}

main()
  .catch((error) => {
    console.error('Reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
