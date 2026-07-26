import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { audit, AuditAction } from '../security/audit.js';
import { generateRecoveryCodes } from '../security/recovery-codes.js';
import { decryptSecret } from '../security/crypto.js';
import { verifyTotp } from '../security/totp.js';
import { revokeAllSessions, revokeSession } from '../security/session.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { publicAccount } from './auth.js';

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/account', guard, async (request, reply) => {
    const account = request.auth.account!;

    const [remainingCodes, sessionCount, serverCount] = await Promise.all([
      prisma.recoveryCode.count({ where: { accountId: account.id, usedAt: null } }),
      prisma.session.count({ where: { accountId: account.id, revokedAt: null } }),
      prisma.server.count({
        where: {
          deletedAt: null,
          OR: [{ ownerId: account.id }, { members: { some: { accountId: account.id } } }],
        },
      }),
    ]);

    return reply.send({
      account: publicAccount(account),
      security: {
        totpEnrolledAt: account.totpEnrolledAt?.toISOString() ?? null,
        remainingRecoveryCodes: remainingCodes,
        activeSessions: sessionCount,
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
      },
      servers: serverCount,
    });
  });

  app.get('/account/sessions', guard, async (request, reply) => {
    const account = request.auth.account!;
    const current = request.auth.session?.id;

    const sessions = await prisma.session.findMany({
      where: { accountId: account.id, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });

    return reply.send({
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === current,
        elevated: session.elevated,
        issuedAt: session.issuedAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.absoluteExpiresAt.toISOString(),
        // Neither the IP nor the user agent is returned - only their hashes are
        // stored, and echoing those back would help nobody.
      })),
    });
  });

  app.delete('/account/sessions/:sessionId', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { sessionId } = z.object({ sessionId: z.string().min(20).max(40) }).parse(request.params);

    const session = await prisma.session.findFirst({
      where: { id: sessionId, accountId: account.id },
    });
    if (!session) throw notFound('Session not found.');

    await revokeSession(sessionId, 'revoked_by_user');

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.SessionRevoked,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });

  /**
   * Regenerating recovery codes requires a fresh TOTP code, so a stolen
   * session cannot be used to mint a permanent backdoor into the account.
   */
  app.post('/account/recovery-codes', guard, async (request, reply) => {
    const account = request.auth.account!;
    const body = z.object({ code: z.string().min(6).max(32) }).parse(request.body);

    if (!account.totpSecretEnc) throw forbidden('Two-factor authentication is not set up.');

    const result = verifyTotp(
      decryptSecret(account.totpSecretEnc, 'totp'),
      body.code,
      account.totpLastStep === null ? null : Number(account.totpLastStep),
    );
    if (!result.valid) throw unauthorized('That code is not correct.');

    const recovery = await generateRecoveryCodes();

    await prisma.$transaction([
      prisma.recoveryCode.deleteMany({ where: { accountId: account.id } }),
      prisma.recoveryCode.createMany({
        data: recovery.hashes.map((codeHash) => ({ accountId: account.id, codeHash })),
      }),
      prisma.account.update({
        where: { id: account.id },
        data: { totpLastStep: BigInt(result.step!) },
      }),
    ]);

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.RecoveryCodesRegenerated,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({
      recoveryCodes: recovery.plaintext,
      message: 'Your previous recovery codes no longer work. Store these somewhere safe.',
    });
  });

  app.post('/account/discord/unlink', guard, async (request, reply) => {
    const account = request.auth.account!;
    if (!account.discordId) throw notFound('No Discord account is linked.');

    await prisma.account.update({
      where: { id: account.id },
      data: {
        discordId: null,
        discordUsername: null,
        discordAvatar: null,
        discordRefreshEnc: null,
      },
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.DiscordUnlinked,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });

  /** The account's own audit trail. */
  app.get('/account/activity', guard, async (request, reply) => {
    const account = request.auth.account!;
    const query = paginationSchema.parse(request.query ?? {});

    const entries = await prisma.auditLog.findMany({
      where: { accountId: account.id },
      orderBy: { at: 'desc' },
      take: query.limit,
      select: {
        id: true,
        at: true,
        action: true,
        targetType: true,
        targetId: true,
        outcome: true,
        metadata: true,
      },
    });

    return reply.send({
      activity: entries.map((entry) => ({
        id: entry.id.toString(),
        at: entry.at.toISOString(),
        action: entry.action,
        target: entry.targetType ? { type: entry.targetType, id: entry.targetId } : null,
        outcome: entry.outcome,
        metadata: entry.metadata,
      })),
    });
  });

  app.delete('/account', guard, async (request, reply) => {
    const account = request.auth.account!;
    const body = z
      .object({ confirmation: z.string(), code: z.string().min(6).max(32) })
      .parse(request.body);

    if (body.confirmation !== account.username) {
      throw forbidden('Type your username exactly to confirm.');
    }
    if (!account.totpSecretEnc) throw forbidden('Two-factor authentication is not set up.');

    const result = verifyTotp(
      decryptSecret(account.totpSecretEnc, 'totp'),
      body.code,
      account.totpLastStep === null ? null : Number(account.totpLastStep),
    );
    if (!result.valid) throw unauthorized('That code is not correct.');

    const owned = await prisma.server.count({ where: { ownerId: account.id, deletedAt: null } });
    if (owned > 0) {
      throw forbidden(
        `Delete or transfer your ${owned} server${owned === 1 ? '' : 's'} before deleting your account.`,
      );
    }

    // Soft delete: the audit trail must survive, and the username stays
    // reserved so it cannot immediately be re-registered by someone else.
    await prisma.account.update({
      where: { id: account.id },
      data: {
        deletedAt: new Date(),
        status: 'DISABLED',
        totpSecretEnc: null,
        discordId: null,
        discordRefreshEnc: null,
      },
    });

    await revokeAllSessions(account.id, 'account_deleted');

    return reply.send({ ok: true });
  });
}
