/**
 * Session management.
 *
 * Design choices and why:
 *   * Opaque random tokens, not JWTs. Revocation is immediate and there is no
 *     signature-stripping or `alg: none` class of bug to worry about.
 *   * Only the SHA-256 digest is stored, so a database read does not yield
 *     usable session tokens.
 *   * Tokens rotate periodically and on every privilege change, which limits
 *     the value of a stolen cookie and defeats session fixation.
 *   * Idle *and* absolute timeouts, both shorter for elevated admin sessions.
 *   * The session is bound to a hashed user-agent; a mismatch revokes it.
 */

import { SESSION } from '@asp/shared';
import type { Account, Session } from '@prisma/client';
import { prisma } from '../db/client.js';
import { generateToken, sha256Hex } from './crypto.js';
import type { ClientIdentity } from './client-identity.js';

export interface IssuedSession {
  /** Raw token for the session cookie. Never persisted. */
  token: string;
  /** Raw CSRF token for the double-submit cookie. Never persisted. */
  csrfToken: string;
  session: Session;
}

export async function createSession(
  account: Pick<Account, 'id'>,
  client: ClientIdentity,
  options: { elevated?: boolean } = {},
): Promise<IssuedSession> {
  const elevated = options.elevated ?? false;
  const token = generateToken(SESSION.tokenBytes);
  const csrfToken = generateToken(32);
  const now = Date.now();

  const absoluteMs = elevated ? SESSION.adminAbsoluteTimeoutMs : SESSION.absoluteTimeoutMs;

  const session = await prisma.session.create({
    data: {
      accountId: account.id,
      tokenHash: sha256Hex(token),
      csrfTokenHash: sha256Hex(csrfToken),
      ipHash: client.ipHash,
      userAgentHash: client.userAgentHash,
      elevated,
      absoluteExpiresAt: new Date(now + absoluteMs),
    },
  });

  return { token, csrfToken, session };
}

export type SessionRejection =
  | 'not_found'
  | 'revoked'
  | 'expired_absolute'
  | 'expired_idle'
  | 'client_mismatch'
  | 'account_unavailable';

export interface ResolvedSession {
  session: Session;
  account: Account;
  /** Set when the token was rotated; the caller must re-issue the cookie. */
  rotated: { token: string; csrfToken: string } | null;
  /**
   * The digest the *incoming* request's CSRF token must match.
   *
   * Not the same as `session.csrfTokenHash` when this request is the one that
   * rotated the session - the browser is still holding the pre-rotation CSRF
   * cookie, and checking it against the freshly written digest would reject
   * every state-changing request that lands on a rotation boundary.
   */
  csrfTokenHash: string;
}

/**
 * How long the pre-rotation token keeps working.
 *
 * The panel polls metrics every five seconds and holds a console socket open,
 * so several requests are routinely in flight at once. All of them carry the
 * old cookie until the rotating response comes back; without this window they
 * would resolve to nothing and the operator would be signed out roughly every
 * fifteen minutes.
 */
const ROTATION_GRACE_MS = 60_000;

export interface SessionLookupResult {
  ok: boolean;
  reason?: SessionRejection;
  resolved?: ResolvedSession;
}

export async function resolveSession(
  token: string,
  client: ClientIdentity,
): Promise<SessionLookupResult> {
  if (!token || token.length < 20 || token.length > 200) {
    return { ok: false, reason: 'not_found' };
  }

  const tokenHash = sha256Hex(token);
  let session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { account: true },
  });

  // Not the current token - it may still be the one this session rotated away
  // from moments ago, held by a request that was already on the wire.
  let viaGrace = false;
  if (!session) {
    session = await prisma.session.findFirst({
      where: {
        previousTokenHash: tokenHash,
        previousTokenExpiresAt: { gt: new Date() },
        revokedAt: null,
      },
      include: { account: true },
    });
    viaGrace = session !== null;
  }

  if (!session) return { ok: false, reason: 'not_found' };
  if (session.revokedAt !== null) return { ok: false, reason: 'revoked' };

  const now = new Date();

  if (session.absoluteExpiresAt <= now) {
    await revokeSession(session.id, 'absolute_timeout');
    return { ok: false, reason: 'expired_absolute' };
  }

  const idleLimit = session.elevated ? SESSION.adminIdleTimeoutMs : SESSION.idleTimeoutMs;
  if (now.getTime() - session.lastSeenAt.getTime() > idleLimit) {
    await revokeSession(session.id, 'idle_timeout');
    return { ok: false, reason: 'expired_idle' };
  }

  // A session presented from a different browser than it was issued to is
  // treated as stolen. IP is intentionally *not* part of this check - mobile
  // clients roam constantly and would be logged out every few minutes.
  if (session.userAgentHash !== client.userAgentHash) {
    await revokeSession(session.id, 'client_mismatch');
    return { ok: false, reason: 'client_mismatch' };
  }

  const account = session.account;
  if (account.deletedAt !== null || account.status === 'DISABLED' || account.status === 'SUSPENDED') {
    await revokeSession(session.id, 'account_unavailable');
    return { ok: false, reason: 'account_unavailable' };
  }

  // Whatever the request presented is what its CSRF token belongs to.
  const csrfTokenHash =
    viaGrace && session.previousCsrfTokenHash ? session.previousCsrfTokenHash : session.csrfTokenHash;

  let rotated: { token: string; csrfToken: string } | null = null;
  let current = session as Session;

  const rotationDue =
    !viaGrace && now.getTime() - session.rotatedAt.getTime() > SESSION.rotateAfterMs;

  if (rotationDue) {
    const candidate = { token: generateToken(SESSION.tokenBytes), csrfToken: generateToken(32) };

    // Conditional on rotatedAt, so of several concurrent requests exactly one
    // rotates. Without this they all would, each handing the browser a
    // different cookie while the database kept only the last - and the next
    // request would authenticate with a token that no longer exists.
    const claimed = await prisma.session.updateMany({
      where: { id: session.id, rotatedAt: session.rotatedAt, revokedAt: null },
      data: {
        tokenHash: sha256Hex(candidate.token),
        csrfTokenHash: sha256Hex(candidate.csrfToken),
        previousTokenHash: session.tokenHash,
        previousCsrfTokenHash: session.csrfTokenHash,
        previousTokenExpiresAt: new Date(now.getTime() + ROTATION_GRACE_MS),
        rotatedAt: now,
        lastSeenAt: now,
        ipHash: client.ipHash,
      },
    });

    if (claimed.count === 1) {
      rotated = candidate;
      current = {
        ...(session as Session),
        tokenHash: sha256Hex(candidate.token),
        csrfTokenHash: sha256Hex(candidate.csrfToken),
        previousTokenHash: session.tokenHash,
        previousCsrfTokenHash: session.csrfTokenHash,
        previousTokenExpiresAt: new Date(now.getTime() + ROTATION_GRACE_MS),
        rotatedAt: now,
        lastSeenAt: now,
        ipHash: client.ipHash,
      };
    } else {
      // Another request won the race. Ours stays on the old cookie, which the
      // grace window keeps valid, and issues no competing Set-Cookie.
      current = { ...(session as Session), lastSeenAt: now };
    }
  } else {
    current = await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now, ipHash: client.ipHash },
    });
  }

  return { ok: true, resolved: { session: current, account, rotated, csrfTokenHash } };
}

/** Rotates the token in place. Called after any privilege change. */
export async function rotateSession(
  sessionId: string,
  options: { elevated?: boolean } = {},
): Promise<{ token: string; csrfToken: string }> {
  const token = generateToken(SESSION.tokenBytes);
  const csrfToken = generateToken(32);
  const now = new Date();

  const data: Record<string, unknown> = {
    tokenHash: sha256Hex(token),
    csrfTokenHash: sha256Hex(csrfToken),
    rotatedAt: now,
    lastSeenAt: now,
    // A privilege change is not a routine rotation: the old token must stop
    // working at once, so no grace window is left behind.
    previousTokenHash: null,
    previousCsrfTokenHash: null,
    previousTokenExpiresAt: null,
  };

  if (options.elevated !== undefined) {
    data.elevated = options.elevated;
    data.absoluteExpiresAt = new Date(
      now.getTime() + (options.elevated ? SESSION.adminAbsoluteTimeoutMs : SESSION.absoluteTimeoutMs),
    );
  }

  await prisma.session.update({ where: { id: sessionId }, data });
  return { token, csrfToken };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await prisma.session
    .updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    .catch(() => undefined);
}

/** Used on password change, TOTP reset and explicit "sign out everywhere". */
export async function revokeAllSessions(
  accountId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      accountId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: {
      OR: [
        { absoluteExpiresAt: { lt: new Date() } },
        { revokedAt: { lt: cutoff } },
      ],
    },
  });
  return result.count;
}
