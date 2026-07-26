/**
 * Tamper-evident audit log.
 *
 * Each entry's hash covers its own canonical content plus the previous entry's
 * hash. Deleting or editing a row therefore breaks every hash after it, and
 * `verifyAuditChain` will point at the exact row where the break starts.
 *
 * Appends are serialised with a Postgres advisory lock so two concurrent
 * writers cannot both read the same `prevHash` and fork the chain.
 */

import { createHash } from 'node:crypto';
import { AUDIT } from '@asp/shared';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';

/** Arbitrary but fixed lock id for the audit chain. */
const AUDIT_LOCK_ID = 728_461_017;

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEntryInput {
  accountId?: string | null;
  /** Human-readable actor, retained even if the account is later deleted. */
  actorLabel: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown> | null;
}

/** Deterministic serialisation so the hash does not depend on key order. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function computeHash(prevHash: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(`${prevHash}|${canonicalize(payload)}`).digest('hex');
}

/**
 * Appends an entry. Never throws into the caller's path: an audit failure must
 * be loud in the logs but must not, for example, prevent a user from stopping a
 * runaway server.
 */
export async function audit(entry: AuditEntryInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;

      const previous = await tx.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { hash: true },
      });
      const prevHash = previous?.hash ?? AUDIT.genesisHash;

      const at = new Date();
      const payload = {
        at: at.toISOString(),
        accountId: entry.accountId ?? null,
        actorLabel: entry.actorLabel,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ipHash: entry.ipHash ?? null,
        userAgentHash: entry.userAgentHash ?? null,
        outcome: entry.outcome ?? 'success',
        metadata: entry.metadata ?? null,
      };

      await tx.auditLog.create({
        data: {
          ...payload,
          at,
          metadata: (entry.metadata ?? undefined) as never,
          prevHash,
          hash: computeHash(prevHash, payload),
        },
      });
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Failed to append audit entry');
  }
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Id of the first entry whose hash does not match. */
  brokenAtId: string | null;
}

export async function verifyAuditChain(limit = 10_000): Promise<ChainVerification> {
  const entries = await prisma.auditLog.findMany({
    orderBy: { id: 'asc' },
    take: limit,
  });

  let expectedPrev = AUDIT.genesisHash;
  let checked = 0;

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrev) {
      return { valid: false, checked, brokenAtId: entry.id.toString() };
    }
    const payload = {
      at: entry.at.toISOString(),
      accountId: entry.accountId,
      actorLabel: entry.actorLabel,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ipHash: entry.ipHash,
      userAgentHash: entry.userAgentHash,
      outcome: entry.outcome,
      metadata: entry.metadata ?? null,
    };
    if (computeHash(entry.prevHash, payload) !== entry.hash) {
      return { valid: false, checked, brokenAtId: entry.id.toString() };
    }
    expectedPrev = entry.hash;
    checked += 1;
  }

  return { valid: true, checked, brokenAtId: null };
}

/** Well-known action names, so queries and alerts have a stable vocabulary. */
export const AuditAction = {
  // auth
  RegisterStarted: 'auth.register.started',
  RegisterCompleted: 'auth.register.completed',
  RegisterBlocked: 'auth.register.blocked',
  UsernameRejected: 'auth.username.rejected',
  UsernameBanIssued: 'auth.username.ban_issued',
  LoginSucceeded: 'auth.login.succeeded',
  LoginFailed: 'auth.login.failed',
  LogoutPerformed: 'auth.logout',
  TotpEnrolled: 'auth.totp.enrolled',
  TotpReplayBlocked: 'auth.totp.replay_blocked',
  RecoveryCodeUsed: 'auth.recovery_code.used',
  RecoveryCodesRegenerated: 'auth.recovery_codes.regenerated',
  AdminBootstrapLogin: 'auth.admin.bootstrap_login',
  AdminPasswordChanged: 'auth.admin.password_changed',
  DiscordLinked: 'auth.discord.linked',
  DiscordUnlinked: 'auth.discord.unlinked',
  SessionRevoked: 'auth.session.revoked',
  AccountLocked: 'auth.account.locked',

  // servers
  ServerCreated: 'server.created',
  ServerDeleted: 'server.deleted',
  ServerUpdated: 'server.updated',
  ServerResourcesChanged: 'server.resources.changed',
  ServerPower: 'server.power',
  ServerReinstalled: 'server.reinstalled',
  ServerSuspended: 'server.suspended',
  ConsoleCommand: 'server.console.command',
  FileWritten: 'server.file.written',
  FileDeleted: 'server.file.deleted',
  FileDownloaded: 'server.file.downloaded',
  ModsChanged: 'server.mods.changed',
  MemberAdded: 'server.member.added',
  MemberRemoved: 'server.member.removed',
  MemberRoleChanged: 'server.member.role_changed',
  BackupCreated: 'server.backup.created',
  BackupRestored: 'server.backup.restored',

  // networking
  PortMappingCreated: 'network.port.mapped',
  PortMappingFailed: 'network.port.failed',
  PortMappingRemoved: 'network.port.removed',
  RelayEnabled: 'network.relay.enabled',

  // platform
  SetupCompleted: 'platform.setup.completed',
  RequirementsChecked: 'platform.requirements.checked',
  RequirementsFailed: 'platform.requirements.failed',
  NodeRegistered: 'platform.node.registered',
  ApiKeyCreated: 'platform.apikey.created',
  ApiKeyRevoked: 'platform.apikey.revoked',
  IntegrationCreated: 'platform.integration.created',
  IntegrationRemoved: 'platform.integration.removed',

  // ai
  AiProviderAdded: 'ai.provider.added',
  AiProviderRemoved: 'ai.provider.removed',
  AiDiagnosisRequested: 'ai.diagnosis.requested',
  AiActionProposed: 'ai.action.proposed',
  AiActionApproved: 'ai.action.approved',
  AiActionRejected: 'ai.action.rejected',
} as const;
