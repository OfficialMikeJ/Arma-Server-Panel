/**
 * Administrator authentication.
 *
 * The spec requires the panel ship with a known default credential
 * (Admin / Password123) that must be changed on first login and then secured
 * with TOTP. A known default password is a weakness by definition, so it is
 * fenced in as tightly as the requirement allows:
 *
 *   * It only works while `platformSettings.bootstrapCredentialActive` is true.
 *     That flag is set false the moment the password is changed, and can never
 *     be set back to true through any API.
 *   * A session created with it is *restricted*: `requireActiveAccount` refuses
 *     every route except change-password and TOTP enrolment, so it cannot be
 *     used to touch a server, read a console, or create an API key.
 *   * The new password must satisfy the full strength policy and cannot
 *     contain "password123" or "admin".
 *   * TOTP enrolment is mandatory immediately afterwards; the account is not
 *     ACTIVE until it completes.
 *   * Every use of the bootstrap credential is audited, including failures.
 */

import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import {
  RATE_LIMITS,
  TOTP,
  adminChangePasswordSchema,
  adminLoginSchema,
  totpEnrollConfirmSchema,
  isPanelAdministrator,
} from '@asp/shared';
import { z } from 'zod';

import { prisma } from '../db/client.js';
import { audit, AuditAction } from '../security/audit.js';
import { buildKey, consumeRateLimit, resetRateLimit } from '../security/rate-limit.js';
import { getClientIdentity } from '../security/client-identity.js';
import { hashPassword, needsRehash, verifyPassword, verifyPasswordDummy } from '../security/password.js';
import { base32Decode, decryptSecret, encryptSecret } from '../security/crypto.js';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from '../security/totp.js';
import { generateRecoveryCodes } from '../security/recovery-codes.js';
import { createSession, revokeAllSessions, rotateSession } from '../security/session.js';
import { clearAuthFailures, getLockoutState, recordAuthFailure } from '../security/lockout.js';
import { clearTrustedDeviceCookie, setSessionCookies } from '../lib/cookies.js';
import { revokeAllDevices } from '../security/trusted-device.js';
import { AppError, badRequest, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js';
import {
  CHALLENGE_TTL,
  consumeChallenge,
  issueChallenge,
  peekChallenge,
  recordChallengeAttempt,
} from '../modules/auth/challenges.js';
import { getPlatformSettings, updatePlatformSettings } from '../modules/platform/platform-settings.js';
import { publicAccount } from './auth.js';

/** The seeded credential, referenced here only to detect and retire it. */
export const BOOTSTRAP_USERNAME = 'Admin';
export const BOOTSTRAP_PASSWORD = 'Password123';

interface AdminTotpPayload extends Record<string, unknown> {
  accountId: string;
  secretBase32: string;
}

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------- */
  /* Password login                                                  */
  /* -------------------------------------------------------------- */

  app.post('/auth/admin/login', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = adminLoginSchema.parse(request.body);

    const limit = await consumeRateLimit(
      buildKey('admin-login', client.ipHash.slice(0, 32)),
      RATE_LIMITS.adminLogin,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many sign-in attempts.', limit.resetMs / 1000);
    }

    const { canonicalizeUsername } = await import('@asp/shared');
    const account = await prisma.account.findFirst({
      where: {
        canonicalUsername: canonicalizeUsername(body.username),
        // Sub-admins hold a password and use this same screen. Filtering to
        // ADMIN here made every sub-admin account unable to sign in at all.
        type: { in: ['ADMIN', 'SUB_ADMIN'] },
        deletedAt: null,
      },
    });

    if (!account || !account.passwordHash) {
      // Burn equivalent CPU so a missing account is indistinguishable by timing.
      await verifyPasswordDummy(body.password);
      await audit({
        actorLabel: body.username.slice(0, 64),
        action: AuditAction.LoginFailed,
        outcome: 'failure',
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { scope: 'admin', reason: 'unknown_account' },
      });
      throw unauthorized('Incorrect username or password.');
    }

    const lockout = await getLockoutState(account.id);
    if (lockout.locked) {
      throw tooManyRequests(
        'This account is temporarily locked after repeated failed attempts.',
        ((lockout.until?.getTime() ?? Date.now()) - Date.now()) / 1000,
      );
    }

    const settings = await getPlatformSettings();
    const usingBootstrapCredential =
      account.mustChangePassword && body.password === BOOTSTRAP_PASSWORD;

    // The default credential is only ever accepted during first-run.
    if (usingBootstrapCredential && !settings.bootstrapCredentialActive) {
      await recordAuthFailure(account.id);
      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.LoginFailed,
        outcome: 'denied',
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { scope: 'admin', reason: 'bootstrap_credential_retired' },
      });
      throw unauthorized('Incorrect username or password.');
    }

    const passwordOk = await verifyPassword(account.passwordHash, body.password);
    if (!passwordOk) {
      const state = await recordAuthFailure(account.id);
      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: state.locked ? AuditAction.AccountLocked : AuditAction.LoginFailed,
        outcome: 'failure',
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { scope: 'admin', failures: state.failures },
      });
      throw unauthorized('Incorrect username or password.');
    }

    if (account.status === 'SUSPENDED' || account.status === 'DISABLED') {
      throw forbidden('This account is not available.');
    }

    // Opportunistic parameter upgrade.
    if (needsRehash(account.passwordHash)) {
      await prisma.account
        .update({ where: { id: account.id }, data: { passwordHash: await hashPassword(body.password) } })
        .catch(() => undefined);
    }

    await clearAuthFailures(account.id);
    await resetRateLimit(buildKey('admin-login', client.ipHash.slice(0, 32)));

    /* ---- First-run: password must change before anything else ---- */
    if (account.mustChangePassword) {
      const issued = await createSession(account, client, { elevated: false });
      setSessionCookies(reply, { token: issued.token, csrfToken: issued.csrfToken }, false);

      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.AdminBootstrapLogin,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { usingDefaultCredential: usingBootstrapCredential },
      });

      return reply.send({
        outcome: 'password_change_required',
        message:
          'This account is still using its first-run password. Choose a new one before continuing.',
        account: publicAccount(account),
      });
    }

    /* ---- Password is set but TOTP is not yet enrolled ---- */
    if (!account.totpVerified || !account.totpSecretEnc) {
      const issued = await createSession(account, client, { elevated: false });
      setSessionCookies(reply, { token: issued.token, csrfToken: issued.csrfToken }, false);

      return reply.send({
        outcome: 'totp_enrollment_required',
        message: 'Set up an authenticator app to finish securing this account.',
        account: publicAccount(account),
      });
    }

    /* ---- Normal path: password is only the first factor ---- */
    const challenge = await issueChallenge({
      kind: 'LOGIN_TOTP',
      accountId: account.id,
      ttlMs: CHALLENGE_TTL.loginTotp,
      maxAttempts: 5,
      payload: { accountId: account.id },
    });

    return reply.send({
      outcome: 'totp_required',
      challengeToken: challenge.token,
      message: 'Enter the 6-digit code from your authenticator app.',
    });
  });

  /* -------------------------------------------------------------- */
  /* Forced password change                                          */
  /* -------------------------------------------------------------- */

  app.post(
    '/auth/admin/change-password',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const client = getClientIdentity(request);
      const account = request.auth.account!;

      if (account.type !== 'ADMIN' || !account.passwordHash) {
        throw forbidden('This account does not use a password.');
      }

      const body = adminChangePasswordSchema.parse(request.body);

      const limit = await consumeRateLimit(
        buildKey('admin-pwchange', account.id),
        RATE_LIMITS.adminLogin,
      );
      if (!limit.allowed) {
        throw tooManyRequests('Too many attempts.', limit.resetMs / 1000);
      }

      if (!(await verifyPassword(account.passwordHash, body.currentPassword))) {
        await recordAuthFailure(account.id);
        throw unauthorized('Your current password is not correct.');
      }

      // Belt and braces: the schema already rejects these phrases.
      if (body.newPassword === BOOTSTRAP_PASSWORD) {
        throw badRequest('You cannot reuse the first-run password.');
      }

      const newHash = await hashPassword(body.newPassword);

      await prisma.$transaction(async (tx) => {
        await tx.account.update({
          where: { id: account.id },
          data: {
            passwordHash: newHash,
            mustChangePassword: false,
            passwordChangedAt: new Date(),
          },
        });
        // Retire the shipped credential permanently, platform-wide.
        await tx.platformSettings.update({
          where: { id: 1 },
          data: { bootstrapCredentialActive: false },
        });
      });

      // A password change invalidates every other session for this account,
      // and every browser that was allowed to skip the authenticator.
      const revoked = await revokeAllSessions(
        account.id,
        'password_changed',
        request.auth.session?.id,
      );
      await revokeAllDevices(account.id, 'password_changed');
      clearTrustedDeviceCookie(reply);

      // Rotate the surviving session so a token captured pre-change is dead.
      if (request.auth.session) {
        const rotated = await rotateSession(request.auth.session.id);
        setSessionCookies(reply, rotated, request.auth.session.elevated);
      }

      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.AdminPasswordChanged,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { otherSessionsRevoked: revoked },
      });

      return reply.send({
        ok: true,
        nextStep: account.totpVerified ? 'complete' : 'totp_enrollment_required',
        message: account.totpVerified
          ? 'Password updated.'
          : 'Password updated. Now set up your authenticator app.',
      });
    },
  );

  /* -------------------------------------------------------------- */
  /* TOTP enrolment for an existing account                          */
  /* -------------------------------------------------------------- */

  app.post(
    '/auth/totp/enroll/start',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const account = request.auth.account!;

      if (account.totpVerified && account.totpSecretEnc) {
        throw new AppError(409, 'totp_already_enrolled', 'Two-factor authentication is already set up.');
      }
      if (isPanelAdministrator(account) && account.mustChangePassword) {
        throw forbidden('Change your password before setting up two-factor authentication.');
      }

      const secret = generateTotpSecret();
      const challenge = await issueChallenge({
        kind: 'TOTP_ENROLLMENT',
        accountId: account.id,
        ttlMs: CHALLENGE_TTL.totpEnrollment,
        maxAttempts: 5,
        payload: { accountId: account.id, secretBase32: secret.base32 } satisfies AdminTotpPayload,
      });

      const otpauth = buildOtpAuthUri({
        secretBase32: secret.base32,
        accountName: account.username,
      });

      return reply.send({
        enrollmentToken: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
        totp: {
          secret: secret.base32,
          otpauthUri: otpauth,
          qrDataUrl: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }),
          digits: TOTP.digits,
          period: TOTP.periodSeconds,
          issuer: TOTP.issuer,
        },
      });
    },
  );

  app.post(
    '/auth/totp/enroll/confirm',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const client = getClientIdentity(request);
      const account = request.auth.account!;
      const body = z
        .object({ enrollmentToken: z.string().min(16).max(256) })
        .merge(totpEnrollConfirmSchema)
        .parse(request.body);

      const lookup = await peekChallenge<AdminTotpPayload>(body.enrollmentToken, 'TOTP_ENROLLMENT');
      if (!lookup.ok || !lookup.challenge?.payload) {
        throw badRequest('Your enrolment session expired. Please start again.');
      }
      if (lookup.challenge.payload.accountId !== account.id) {
        throw forbidden('That enrolment session belongs to another account.');
      }

      const secret = base32Decode(lookup.challenge.payload.secretBase32);
      const verification = verifyTotp(secret, body.code, null);

      if (!verification.valid) {
        const remaining = await recordChallengeAttempt(lookup.challenge.id);
        throw badRequest(
          remaining > 0
            ? `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
            : 'Too many incorrect codes. Please start again.',
        );
      }

      if (!(await consumeChallenge(lookup.challenge.id))) {
        throw badRequest('That enrolment session has already been used.');
      }

      const recovery = await generateRecoveryCodes();

      // Re-enrolling replaces the second factor, so previous bypasses die too.
      await revokeAllDevices(account.id, 'totp_reenrolled');
      clearTrustedDeviceCookie(reply);

      await prisma.$transaction(async (tx) => {
        await tx.recoveryCode.deleteMany({ where: { accountId: account.id } });
        await tx.account.update({
          where: { id: account.id },
          data: {
            totpSecretEnc: encryptSecret(secret, 'totp'),
            totpEnrolledAt: new Date(),
            totpVerified: true,
            totpLastStep: BigInt(verification.step!),
            status: 'ACTIVE',
            recoveryCodes: { create: recovery.hashes.map((codeHash) => ({ codeHash })) },
          },
        });
      });

      // Enrolment is a privilege change - rotate and elevate.
      if (request.auth.session) {
        const rotated = await rotateSession(request.auth.session.id, {
          elevated: isPanelAdministrator(account),
        });
        setSessionCookies(reply, rotated, isPanelAdministrator(account));
      }

      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.TotpEnrolled,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
      });

      return reply.send({
        ok: true,
        recoveryCodes: recovery.plaintext,
        message: 'Two-factor authentication is now active. Store these recovery codes somewhere safe.',
      });
    },
  );

  /* -------------------------------------------------------------- */
  /* Step-up: re-prove TOTP to elevate an existing session           */
  /* -------------------------------------------------------------- */

  app.post(
    '/auth/admin/step-up',
    { onRequest: [app.requireAuth, app.requireActiveAccount] },
    async (request, reply) => {
      const client = getClientIdentity(request);
      const account = request.auth.account!;
      const session = request.auth.session;

      if (!session) throw forbidden('Step-up requires a browser session.');
      if (!isPanelAdministrator(account)) {
        throw forbidden('Administrator access is required.');
      }
      if (!account.totpSecretEnc) throw forbidden('Two-factor authentication is not set up.');

      const body = z.object({ code: z.string().min(6).max(32) }).parse(request.body);

      const limit = await consumeRateLimit(buildKey('step-up', account.id), RATE_LIMITS.totpVerify);
      if (!limit.allowed) {
        throw tooManyRequests('Too many attempts.', limit.resetMs / 1000);
      }

      const result = verifyTotp(
        decryptSecret(account.totpSecretEnc, 'totp'),
        body.code,
        account.totpLastStep === null ? null : Number(account.totpLastStep),
      );

      if (!result.valid) {
        await recordAuthFailure(account.id);
        throw unauthorized('That code is not correct.');
      }

      await prisma.account.update({
        where: { id: account.id },
        data: { totpLastStep: BigInt(result.step!) },
      });

      const rotated = await rotateSession(session.id, { elevated: true });
      setSessionCookies(reply, rotated, true);

      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.LoginSucceeded,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { stepUp: true },
      });

      return reply.send({ ok: true, elevated: true });
    },
  );

  /* -------------------------------------------------------------- */
  /* First-run status, for the setup UI                              */
  /* -------------------------------------------------------------- */

  app.get('/auth/admin/bootstrap-status', async (_request, reply) => {
    const settings = await getPlatformSettings();
    const admin = await prisma.account.findFirst({
      where: { type: 'ADMIN', deletedAt: null },
      select: { mustChangePassword: true, totpVerified: true },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      setupComplete: settings.setupComplete,
      // True only while the shipped default credential still works.
      usingDefaultCredential: settings.bootstrapCredentialActive && (admin?.mustChangePassword ?? false),
      passwordChangeRequired: admin?.mustChangePassword ?? false,
      totpEnrollmentRequired: !(admin?.totpVerified ?? false),
    });
  });
}

/** Called by the setup flow once everything is satisfied. */
export async function markSetupComplete(): Promise<void> {
  await updatePlatformSettings({ setupComplete: true, bootstrapCredentialActive: false });
}
