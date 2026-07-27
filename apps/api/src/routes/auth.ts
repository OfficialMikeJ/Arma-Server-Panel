/**
 * User authentication.
 *
 * Users have no password at all - a username identifies the account and a TOTP
 * code from an authenticator app proves control of it. That removes password
 * reuse, credential stuffing and phishing-for-passwords as attack classes
 * entirely; the trade-off is that losing the authenticator means falling back
 * to a recovery code.
 */

import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import {
  RATE_LIMITS,
  TOTP,
  loginStartSchema,
  loginVerifySchema,
  looksLikeRecoveryCode,
  registerCompleteSchema,
  registerStartSchema,
  usernameSchema,
  panelPermissionsFor,
  isPanelAdministrator,
} from '@asp/shared';
import { z } from 'zod';

import { prisma } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { audit, AuditAction } from '../security/audit.js';
import { buildKey, consumeRateLimit, resetRateLimit } from '../security/rate-limit.js';
import { getClientIdentity } from '../security/client-identity.js';
import { decryptSecret, encryptSecret, generateToken } from '../security/crypto.js';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from '../security/totp.js';
import { findMatchingRecoveryCode, generateRecoveryCodes } from '../security/recovery-codes.js';
import { createSession, revokeAllSessions, revokeSession } from '../security/session.js';
import { clearAuthFailures, getLockoutState, recordAuthFailure } from '../security/lockout.js';
import {
  clearSessionCookies,
  clearTrustedDeviceCookie,
  readTrustedDeviceCookie,
  setSessionCookies,
  setTrustedDeviceCookie,
} from '../lib/cookies.js';
import {
  isDeviceTrusted,
  revokeAllDevices,
  trustDevice,
} from '../security/trusted-device.js';
import {
  AppError,
  badRequest,
  forbidden,
  tooManyRequests,
  unauthorized,
} from '../lib/errors.js';
import { screenUsername, getActiveBan } from '../modules/auth/username-policy.js';
import { isRegistrationOpen } from '../modules/platform/platform-settings.js';
import {
  CHALLENGE_TTL,
  consumeChallenge,
  issueChallenge,
  peekChallenge,
  recordChallengeAttempt,
} from '../modules/auth/challenges.js';
import {
  completeDiscordAuth,
  findAccountByDiscordId,
  isDiscordEnabled,
  startDiscordAuth,
} from '../modules/auth/discord.js';

interface EnrollmentPayload extends Record<string, unknown> {
  username: string;
  canonicalUsername: string;
  /** Base32 secret, held only inside the encrypted challenge payload. */
  secretBase32: string;
  discordId: string | null;
  discordUsername: string | null;
  discordAvatar: string | null;
}

interface LoginPayload extends Record<string, unknown> {
  accountId: string;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------- */
  /* Username availability + screening                               */
  /* -------------------------------------------------------------- */

  app.post('/auth/username/check', async (request, reply) => {
    const body = z.object({ username: usernameSchema }).parse(request.body);
    const client = getClientIdentity(request);

    const result = await screenUsername(body.username, {
      clientHash: client.clientHash,
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
    });

    if (result.status === 'banned' || result.status === 'already_banned') {
      return reply.status(429).send({
        error: {
          code: 'registration_banned',
          message: result.message,
          requestId: request.id,
        },
        retryAfterSeconds: Math.ceil((result.retryAfterMs ?? 0) / 1000),
      });
    }

    if (result.status === 'rate_limited') {
      throw tooManyRequests(result.message, (result.retryAfterMs ?? 60_000) / 1000);
    }

    return reply.send({
      available: result.status === 'accepted',
      status: result.status,
      message: result.message,
      isFinalWarning: result.isFinalWarning ?? false,
    });
  });

  /* -------------------------------------------------------------- */
  /* Registration - step 1: claim a username, get a TOTP secret      */
  /* -------------------------------------------------------------- */

  app.post('/auth/register/start', async (request, reply) => {
    const client = getClientIdentity(request);

    const registration = await isRegistrationOpen();
    if (!registration.open) {
      throw forbidden(registration.reason ?? 'Registration is closed.');
    }

    const limit = await consumeRateLimit(
      buildKey('register', client.ipHash.slice(0, 32)),
      RATE_LIMITS.register,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many registration attempts.', limit.resetMs / 1000);
    }

    const body = registerStartSchema.parse(request.body);

    // A Discord-linked registration carries a link token from the OAuth
    // callback. It is single-use and short-lived.
    let discordId: string | null = null;
    let discordUsername: string | null = null;
    let discordAvatar: string | null = null;

    if (body.discordLinkToken) {
      const link = await peekChallenge<{
        discordId: string;
        discordUsername: string;
        discordAvatar: string | null;
      }>(body.discordLinkToken, 'DISCORD_LINK');

      if (!link.ok || !link.challenge?.payload) {
        throw badRequest('Your Discord sign-in expired. Please start again.');
      }
      discordId = link.challenge.payload.discordId;
      discordUsername = link.challenge.payload.discordUsername;
      discordAvatar = link.challenge.payload.discordAvatar;

      const existing = await findAccountByDiscordId(discordId);
      if (existing) {
        throw new AppError(409, 'discord_already_linked', 'That Discord account already has a panel account.');
      }
    }

    const screen = await screenUsername(body.username, {
      clientHash: client.clientHash,
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      externalId: discordId,
    });

    if (screen.status !== 'accepted') {
      await audit({
        actorLabel: 'anonymous',
        action: AuditAction.RegisterBlocked,
        outcome: 'denied',
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { status: screen.status, reason: screen.check.reason },
      });

      const status =
        screen.status === 'banned' || screen.status === 'already_banned' || screen.status === 'rate_limited'
          ? 429
          : 422;

      return reply.status(status).send({
        error: {
          code:
            screen.status === 'banned' || screen.status === 'already_banned'
              ? 'registration_banned'
              : screen.status === 'warned'
                ? 'username_warning'
                : 'username_rejected',
          message: screen.message,
          requestId: request.id,
        },
        isFinalWarning: screen.isFinalWarning ?? false,
        retryAfterSeconds: screen.retryAfterMs ? Math.ceil(screen.retryAfterMs / 1000) : undefined,
      });
    }

    const secret = generateTotpSecret();
    const challenge = await issueChallenge({
      kind: 'TOTP_ENROLLMENT',
      ttlMs: CHALLENGE_TTL.totpEnrollment,
      maxAttempts: 5,
      payload: {
        username: body.username,
        canonicalUsername: screen.check.canonical,
        secretBase32: secret.base32,
        discordId,
        discordUsername,
        discordAvatar,
      } satisfies EnrollmentPayload,
    });

    const otpauth = buildOtpAuthUri({
      secretBase32: secret.base32,
      accountName: body.username,
    });
    const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });

    await audit({
      actorLabel: body.username,
      action: AuditAction.RegisterStarted,
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      metadata: { discordLinked: discordId !== null },
    });

    return reply.send({
      enrollmentToken: challenge.token,
      expiresAt: challenge.expiresAt.toISOString(),
      totp: {
        secret: secret.base32,
        otpauthUri: otpauth,
        qrDataUrl,
        digits: TOTP.digits,
        period: TOTP.periodSeconds,
        issuer: TOTP.issuer,
      },
      discord: discordId ? { id: discordId, username: discordUsername } : null,
    });
  });

  /* -------------------------------------------------------------- */
  /* Registration - step 2: prove the authenticator works            */
  /* -------------------------------------------------------------- */

  app.post('/auth/register/complete', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = registerCompleteSchema.parse(request.body);

    const ban = await getActiveBan(client.clientHash);
    if (ban) {
      throw tooManyRequests(
        'Registration from this connection is temporarily blocked.',
        (ban.expiresAt.getTime() - Date.now()) / 1000,
      );
    }

    const lookup = await peekChallenge<EnrollmentPayload>(body.enrollmentToken, 'TOTP_ENROLLMENT');
    if (!lookup.ok || !lookup.challenge?.payload) {
      throw badRequest('Your enrolment session expired. Please start again.');
    }

    const payload = lookup.challenge.payload;
    const { base32Decode } = await import('../security/crypto.js');
    const secret = base32Decode(payload.secretBase32);

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

    // Re-check availability: someone may have taken the name during enrolment.
    const taken = await prisma.account.findFirst({
      where: { canonicalUsername: payload.canonicalUsername, deletedAt: null },
      select: { id: true },
    });
    if (taken) {
      throw new AppError(409, 'username_taken', 'That username was claimed while you were enrolling.');
    }

    const recovery = await generateRecoveryCodes();

    const account = await prisma.account.create({
      data: {
        type: 'USER',
        status: 'ACTIVE',
        username: payload.username,
        canonicalUsername: payload.canonicalUsername,
        totpSecretEnc: encryptSecret(secret, 'totp'),
        totpEnrolledAt: new Date(),
        totpVerified: true,
        totpLastStep: BigInt(verification.step!),
        discordId: payload.discordId,
        discordUsername: payload.discordUsername,
        discordAvatar: payload.discordAvatar,
        recoveryCodes: {
          create: recovery.hashes.map((codeHash) => ({ codeHash })),
        },
      },
    });

    const issued = await createSession(account, client);
    setSessionCookies(reply, { token: issued.token, csrfToken: issued.csrfToken }, false);

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.RegisterCompleted,
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      metadata: { discordLinked: payload.discordId !== null },
    });

    return reply.status(201).send({
      account: publicAccount(account),
      // Shown exactly once. There is no way to retrieve these later.
      recoveryCodes: recovery.plaintext,
    });
  });

  /* -------------------------------------------------------------- */
  /* Login - step 1: identify                                        */
  /* -------------------------------------------------------------- */

  app.post('/auth/login/start', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = loginStartSchema.parse(request.body);

    const limit = await consumeRateLimit(
      buildKey('login', client.ipHash.slice(0, 32)),
      RATE_LIMITS.auth,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many sign-in attempts.', limit.resetMs / 1000);
    }

    const { canonicalizeUsername } = await import('@asp/shared');
    const account = await prisma.account.findFirst({
      where: { canonicalUsername: canonicalizeUsername(body.username), deletedAt: null },
    });

    // This browser may already have proved TOTP for this account recently.
    // Only the second factor is waived - identity still had to be supplied.
    if (account && account.totpVerified && account.status === 'ACTIVE') {
      const deviceToken = readTrustedDeviceCookie(
        request.cookies as Record<string, string | undefined>,
      );

      if (await isDeviceTrusted(deviceToken, account.id, client)) {
        const lockout = await getLockoutState(account.id);
        if (lockout.locked) {
          throw tooManyRequests(
            'This account is temporarily locked after repeated failed attempts.',
            ((lockout.until?.getTime() ?? Date.now()) - Date.now()) / 1000,
          );
        }

        await prisma.account.update({
          where: { id: account.id },
          data: { lastLoginAt: new Date(), lastLoginIpHash: client.ipHash },
        });

        // Never elevated: an administrator still steps up with a fresh code
        // before anything privileged.
        const issued = await createSession(account, client, { elevated: false });
        setSessionCookies(reply, { token: issued.token, csrfToken: issued.csrfToken }, false);

        await audit({
          accountId: account.id,
          actorLabel: account.username,
          action: AuditAction.LoginSucceeded,
          ipHash: client.ipHash,
          userAgentHash: client.userAgentHash,
          metadata: { method: 'trusted_device' },
        });

        return reply.send({
          outcome: 'authenticated',
          account: publicAccount(account),
          message: 'Signed in on a remembered device.',
        });
      }
    }

    // A challenge is always issued, even for an unknown username, so the
    // response is identical either way and accounts cannot be enumerated.
    const challenge = await issueChallenge({
      kind: 'LOGIN_TOTP',
      accountId: account?.id ?? null,
      ttlMs: CHALLENGE_TTL.loginTotp,
      maxAttempts: 5,
      payload: account ? ({ accountId: account.id } satisfies LoginPayload) : { accountId: '' },
    });

    return reply.send({
      outcome: 'totp_required',
      challengeToken: challenge.token,
      expiresAt: challenge.expiresAt.toISOString(),
      message: 'Enter the 6-digit code from your authenticator app.',
    });
  });

  /* -------------------------------------------------------------- */
  /* Login - step 2: TOTP or recovery code                           */
  /* -------------------------------------------------------------- */

  app.post('/auth/login/verify', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = loginVerifySchema.parse(request.body);

    const limit = await consumeRateLimit(
      buildKey('login-verify', client.ipHash.slice(0, 32)),
      RATE_LIMITS.totpVerify,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many code attempts.', limit.resetMs / 1000);
    }

    const lookup = await peekChallenge<LoginPayload>(body.challengeToken, 'LOGIN_TOTP');
    if (!lookup.ok || !lookup.challenge) {
      throw unauthorized('That sign-in attempt expired. Please start again.');
    }

    const accountId = lookup.challenge.payload?.accountId;
    if (!accountId) {
      // Unknown username. Burn an attempt and give the same message a wrong
      // code would produce.
      await recordChallengeAttempt(lookup.challenge.id);
      throw unauthorized('That code is not correct.');
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { recoveryCodes: true },
    });
    if (!account || account.deletedAt !== null) {
      await recordChallengeAttempt(lookup.challenge.id);
      throw unauthorized('That code is not correct.');
    }

    const lockout = await getLockoutState(account.id);
    if (lockout.locked) {
      throw tooManyRequests(
        'This account is temporarily locked after repeated failed attempts.',
        ((lockout.until?.getTime() ?? Date.now()) - Date.now()) / 1000,
      );
    }

    if (account.status === 'SUSPENDED' || account.status === 'DISABLED') {
      throw forbidden('This account is not available.');
    }
    if (!account.totpSecretEnc || !account.totpVerified) {
      throw forbidden('This account has not finished two-factor setup.');
    }

    // Decided by shape, not by punctuation: a recovery code normalises to 16
    // base32 characters whether or not the user kept the hyphens.
    const isRecoveryCode = looksLikeRecoveryCode(body.code);
    let verifiedStep: number | null = null;
    let usedRecoveryCodeId: string | null = null;

    if (isRecoveryCode) {
      usedRecoveryCodeId = await findMatchingRecoveryCode(body.code, account.recoveryCodes);
      if (!usedRecoveryCodeId) {
        await onFailedLogin(account.id, lookup.challenge.id, client);
        throw unauthorized('That code is not correct.');
      }
    } else {
      const secret = decryptSecret(account.totpSecretEnc, 'totp');
      const result = verifyTotp(
        secret,
        body.code,
        account.totpLastStep === null ? null : Number(account.totpLastStep),
      );

      if (!result.valid) {
        if (result.reason === 'replayed') {
          await audit({
            accountId: account.id,
            actorLabel: account.username,
            action: AuditAction.TotpReplayBlocked,
            outcome: 'denied',
            ipHash: client.ipHash,
            userAgentHash: client.userAgentHash,
          });
        }
        await onFailedLogin(account.id, lookup.challenge.id, client);
        throw unauthorized('That code is not correct.');
      }
      verifiedStep = result.step;
    }

    if (!(await consumeChallenge(lookup.challenge.id))) {
      throw unauthorized('That sign-in attempt has already been used.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: account.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIpHash: client.ipHash,
          failedAuthCount: 0,
          lockedUntil: null,
          ...(verifiedStep !== null ? { totpLastStep: BigInt(verifiedStep) } : {}),
        },
      });
      if (usedRecoveryCodeId) {
        await tx.recoveryCode.update({
          where: { id: usedRecoveryCodeId },
          data: { usedAt: new Date() },
        });
      }
    });

    await resetRateLimit(buildKey('login-verify', client.ipHash.slice(0, 32)));

    const issued = await createSession(account, client, {
      elevated: isPanelAdministrator(account),
    });
    setSessionCookies(
      reply,
      { token: issued.token, csrfToken: issued.csrfToken },
      isPanelAdministrator(account),
    );

    // Only offered after a real second factor. A recovery code is a sign that
    // the authenticator is already lost, so it does not earn a 14-day bypass.
    if (body.rememberDevice && !usedRecoveryCodeId) {
      const device = await trustDevice(account.id, client);
      setTrustedDeviceCookie(reply, device.token);
    }

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: usedRecoveryCodeId ? AuditAction.RecoveryCodeUsed : AuditAction.LoginSucceeded,
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      metadata: { method: usedRecoveryCodeId ? 'recovery_code' : 'totp' },
    });

    const remainingCodes = account.recoveryCodes.filter(
      (c) => c.usedAt === null && c.id !== usedRecoveryCodeId,
    ).length;

    return reply.send({
      account: publicAccount(account),
      mustChangePassword: account.mustChangePassword,
      usedRecoveryCode: usedRecoveryCodeId !== null,
      remainingRecoveryCodes: remainingCodes,
    });
  });

  /* -------------------------------------------------------------- */
  /* Discord OAuth                                                   */
  /* -------------------------------------------------------------- */

  app.get('/auth/discord/status', async (_request, reply) =>
    reply.send({ enabled: isDiscordEnabled() }),
  );

  app.post('/auth/discord/start', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = z
      .object({
        intent: z.enum(['register', 'login', 'link']).default('login'),
        returnTo: z.string().max(256).default('/panel'),
      })
      .parse(request.body ?? {});

    if (body.intent === 'link' && !request.auth.account) {
      throw unauthorized('Sign in before linking a Discord account.');
    }

    const limit = await consumeRateLimit(
      buildKey('discord-start', client.ipHash.slice(0, 32)),
      RATE_LIMITS.auth,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many attempts.', limit.resetMs / 1000);
    }

    const start = await startDiscordAuth({
      intent: body.intent,
      returnTo: body.returnTo,
      userAgentHash: client.userAgentHash,
      accountId: request.auth.account?.id ?? null,
    });

    return reply.send({ url: start.url, expiresAt: start.expiresAt.toISOString() });
  });

  app.post('/auth/discord/callback', async (request, reply) => {
    const client = getClientIdentity(request);
    const body = z
      .object({
        code: z.string().min(1).max(512),
        state: z.string().min(16).max(256),
      })
      .parse(request.body);

    const result = await completeDiscordAuth({
      code: body.code,
      state: body.state,
      userAgentHash: client.userAgentHash,
    });

    const existing = await findAccountByDiscordId(result.profile.id);

    // ---- Linking to the signed-in account ----
    if (result.intent === 'link') {
      const account = request.auth.account;
      if (!account) throw unauthorized('Sign in before linking a Discord account.');
      if (existing && existing.id !== account.id) {
        throw new AppError(409, 'discord_already_linked', 'That Discord account is already linked elsewhere.');
      }

      await prisma.account.update({
        where: { id: account.id },
        data: {
          discordId: result.profile.id,
          discordUsername: result.profile.globalName ?? result.profile.username,
          discordAvatar: result.profile.avatarUrl,
          discordRefreshEnc: result.refreshTokenEnc,
        },
      });

      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.DiscordLinked,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
      });

      return reply.send({ outcome: 'linked', returnTo: result.returnTo });
    }

    // ---- Existing account: still requires TOTP ----
    if (existing) {
      if (existing.status === 'SUSPENDED' || existing.status === 'DISABLED') {
        throw forbidden('This account is not available.');
      }

      const challenge = await issueChallenge({
        kind: 'LOGIN_TOTP',
        accountId: existing.id,
        ttlMs: CHALLENGE_TTL.loginTotp,
        maxAttempts: 5,
        payload: { accountId: existing.id } satisfies LoginPayload,
      });

      return reply.send({
        outcome: 'totp_required',
        challengeToken: challenge.token,
        username: existing.username,
        returnTo: result.returnTo,
      });
    }

    // ---- New account: hand back a link token for the registration flow ----
    const registration = await isRegistrationOpen();
    if (!registration.open) {
      throw forbidden(registration.reason ?? 'Registration is closed.');
    }

    const linkChallenge = await issueChallenge({
      kind: 'DISCORD_LINK',
      ttlMs: CHALLENGE_TTL.discordLink,
      maxAttempts: 3,
      payload: {
        discordId: result.profile.id,
        discordUsername: result.profile.globalName ?? result.profile.username,
        discordAvatar: result.profile.avatarUrl,
      },
    });

    return reply.send({
      outcome: 'registration_required',
      discordLinkToken: linkChallenge.token,
      suggestedUsername: sanitizeSuggestion(result.profile.globalName ?? result.profile.username),
      discord: { id: result.profile.id, username: result.profile.username },
      returnTo: result.returnTo,
    });
  });

  /* -------------------------------------------------------------- */
  /* Session lifecycle                                               */
  /* -------------------------------------------------------------- */

  app.get('/auth/session', async (request, reply) => {
    if (!request.auth.account) {
      return reply.send({ authenticated: false, discordEnabled: isDiscordEnabled() });
    }
    const account = request.auth.account;
    return reply.send({
      authenticated: true,
      account: publicAccount(account),
      elevated: request.auth.session?.elevated ?? false,
      mustChangePassword: account.mustChangePassword,
      totpVerified: account.totpVerified,
      discordEnabled: isDiscordEnabled(),
      csrfHeaderName: 'x-asp-csrf',
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const { account, session, client } = request.auth;

    if (session) await revokeSession(session.id, 'user_logout');
    clearSessionCookies(reply);
    // A normal sign-out keeps the device trusted; that is what the option is
    // for. "Sign out everywhere" below is what revokes it.

    if (account) {
      await audit({
        accountId: account.id,
        actorLabel: account.username,
        action: AuditAction.LogoutPerformed,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
      });
    }

    return reply.send({ ok: true });
  });

  app.post(
    '/auth/logout-everywhere',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const { account, session, client } = request.auth;
      const revoked = await revokeAllSessions(account!.id, 'logout_everywhere', session?.id);
      // Signing out everywhere has to mean everywhere, including browsers that
      // would otherwise skip the authenticator.
      const devices = await revokeAllDevices(account!.id, 'logout_everywhere');
      clearTrustedDeviceCookie(reply);

      await audit({
        accountId: account!.id,
        actorLabel: account!.username,
        action: AuditAction.SessionRevoked,
        ipHash: client.ipHash,
        userAgentHash: client.userAgentHash,
        metadata: { revoked, trustedDevicesRevoked: devices },
      });

      return reply.send({ ok: true, revoked, trustedDevicesRevoked: devices });
    },
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function onFailedLogin(
  accountId: string,
  challengeId: string,
  client: { ipHash: string; userAgentHash: string },
): Promise<void> {
  await recordChallengeAttempt(challengeId);
  const state = await recordAuthFailure(accountId);

  await audit({
    accountId,
    actorLabel: 'unknown',
    action: state.locked ? AuditAction.AccountLocked : AuditAction.LoginFailed,
    outcome: 'failure',
    ipHash: client.ipHash,
    userAgentHash: client.userAgentHash,
    metadata: { failures: state.failures },
  });
}

/** Turns a Discord display name into something the username policy will accept. */
function sanitizeSuggestion(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 24);
  return cleaned.length >= 3 ? cleaned : '';
}

export function publicAccount(account: {
  id: string;
  username: string;
  type: string;
  status: string;
  discordId: string | null;
  discordUsername: string | null;
  discordAvatar: string | null;
  isPlatformOwner: boolean;
  totpVerified: boolean;
  panelPermissions?: string[];
  createdAt: Date;
}) {
  return {
    id: account.id,
    username: account.username,
    type: account.type,
    status: account.status,
    isPlatformOwner: account.isPlatformOwner,
    totpVerified: account.totpVerified,
    // Resolved, not the raw column: a full administrator holds everything
    // without anything being stored, so the client can treat one list as the
    // answer to "what may I do to the panel".
    panelPermissions: [...panelPermissionsFor(account)],
    discord: account.discordId
      ? { id: account.discordId, username: account.discordUsername, avatar: account.discordAvatar }
      : null,
    createdAt: account.createdAt.toISOString(),
  };
}

// Referenced by the admin routes for the same helpers.
export { generateToken, loadConfig };
