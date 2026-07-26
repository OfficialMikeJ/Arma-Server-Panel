import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GAMES,
  RATE_LIMITS,
  aiDiagnoseSchema,
  aiProviderSchema,
  consoleCommandSchema,
  cuidSchema,
  resourceAllocationSchema,
  writeFileSchema,
  type Permission,
} from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { encryptSecret } from '../security/crypto.js';
import { buildKey, consumeRateLimit } from '../security/rate-limit.js';
import { assertUrlIsSafe } from '../security/ssrf.js';
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.js';
import {
  ACTION_PERMISSION,
  askAssistant,
  buildContext,
  type ProposedActionKind,
} from '../modules/ai/ai-assistant.js';
import {
  loadServer,
  performPowerAction,
  toGameId,
  updateResources,
} from '../modules/servers/server-service.js';
import {
  getServerMods,
  reorderMods,
  setServerMods,
  toggleMod,
  validateModId,
} from '../modules/mods/mod-manager.js';
import { getAdapter } from '../modules/games/registry.js';
import { writeTextFile } from '../modules/files/file-service.js';
import { emitPanelNotice } from '../modules/servers/console-buffer.js';

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /* -------------------------------------------------------------- */
  /* Providers - bring your own key                                  */
  /* -------------------------------------------------------------- */

  app.get('/ai/providers', guard, async (request, reply) => {
    const account = request.auth.account!;
    const providers = await prisma.aiProvider.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      providers: providers.map((provider) => ({
        id: provider.id,
        provider: provider.provider,
        label: provider.label,
        model: provider.model,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        // Only the last four characters, so a key is identifiable but not usable.
        apiKeyHint: provider.apiKeyHint,
        autonomousActions: provider.autonomousActions,
        createdAt: provider.createdAt.toISOString(),
      })),
      supported: [
        { id: 'anthropic', label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-5' },
        { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o' },
        { id: 'openai-codex', label: 'OpenAI Codex', defaultModel: 'gpt-4o' },
        { id: 'custom', label: 'Custom (OpenAI-compatible)', defaultModel: '' },
      ],
    });
  });

  app.post('/ai/providers', guard, async (request, reply) => {
    const account = request.auth.account!;

    // An API key must not be able to register a new AI credential.
    if (request.auth.method === 'api_key') {
      throw forbidden('AI providers can only be added from a signed-in session.');
    }

    const body = aiProviderSchema.parse(request.body);

    if (body.provider === 'custom') {
      if (!body.baseUrl) throw badRequest('A custom provider needs a base URL.');
      // Validated now and re-validated at every call.
      await assertUrlIsSafe(body.baseUrl);
    }

    // Autonomous actions are opt-in and default to none. Reinstall and delete
    // can never be autonomous, no matter what the operator asks for.
    const forbiddenAutonomous: Permission[] = ['server:reinstall', 'server:delete'];
    const autonomous = body.autonomousActions.filter((p) => !forbiddenAutonomous.includes(p));

    const provider = await prisma.aiProvider.create({
      data: {
        accountId: account.id,
        provider: body.provider,
        label: body.label,
        model: body.model,
        baseUrl: body.baseUrl,
        apiKeyEnc: encryptSecret(body.apiKey, 'ai-key'),
        apiKeyHint: `...${body.apiKey.slice(-4)}`,
        autonomousActions: autonomous,
      },
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AiProviderAdded,
      targetType: 'ai_provider',
      targetId: provider.id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { provider: body.provider, model: body.model, autonomous: autonomous.length },
    });

    return reply.status(201).send({
      provider: { id: provider.id, label: provider.label, model: provider.model },
      note:
        autonomous.length < body.autonomousActions.length
          ? 'Reinstall and delete cannot be granted autonomously and were removed.'
          : null,
    });
  });

  app.delete('/ai/providers/:providerId', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { providerId } = z.object({ providerId: cuidSchema }).parse(request.params);

    const deleted = await prisma.aiProvider.deleteMany({
      where: { id: providerId, accountId: account.id },
    });
    if (deleted.count === 0) throw notFound('Provider not found.');

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AiProviderRemoved,
      targetType: 'ai_provider',
      targetId: providerId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    return reply.send({ ok: true });
  });

  /* -------------------------------------------------------------- */
  /* Diagnose                                                        */
  /* -------------------------------------------------------------- */

  app.post('/servers/:id/ai/diagnose', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:ai');

    const body = aiDiagnoseSchema.parse(request.body);

    const limit = await consumeRateLimit(buildKey('ai', account.id), RATE_LIMITS.ai);
    if (!limit.allowed) {
      throw tooManyRequests('Too many AI requests this hour.', limit.resetMs / 1000);
    }

    const provider = await prisma.aiProvider.findFirst({
      where: { id: body.providerId, accountId: account.id, enabled: true },
    });
    if (!provider) throw notFound('AI provider not found.');

    const server = await loadServer(id);

    // Only context the operator explicitly consented to is assembled, and it
    // is redacted on the way out.
    const context = await buildContext(server, {
      console: body.include.console,
      config: body.include.config,
      mods: body.include.mods,
      metrics: body.include.metrics,
      files: body.include.files,
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AiDiagnosisRequested,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { provider: provider.provider, model: provider.model, included: context.included },
    });

    const response = await askAssistant(provider, body.question, context.text);

    // Drop any proposal the caller could not perform themselves.
    const actionable = response.actions.filter((action) => {
      const permission = ACTION_PERMISSION[action.kind as ProposedActionKind] as Permission;
      return permission === 'server:read' || access.permissions.has(permission);
    });

    const session = await prisma.aiSession.create({
      data: {
        providerId: provider.id,
        serverId: id,
        accountId: account.id,
        question: body.question,
        transcript: [
          { role: 'user', content: body.question },
          { role: 'assistant', content: response.summary },
        ] as never,
        proposedActions: actionable.map((action) => ({ ...action, status: 'pending' })) as never,
        status: actionable.length > 0 ? 'awaiting_approval' : 'closed',
      },
    });

    return reply.send({
      sessionId: session.id,
      summary: response.summary,
      diagnosis: response.diagnosis,
      contextIncluded: context.included,
      actions: actionable.map((action, index) => ({
        index,
        kind: action.kind,
        rationale: action.rationale,
        parameters: action.parameters,
        risk: action.risk,
      })),
      droppedActions: response.actions.length - actionable.length,
      // Stated plainly so the operator understands the trust boundary.
      notice:
        'These are suggestions. Nothing has been changed. Review each action before approving it.',
    });
  });

  /* -------------------------------------------------------------- */
  /* Approve a proposed action                                       */
  /* -------------------------------------------------------------- */

  app.post('/ai/sessions/:sessionId/approve', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { sessionId } = z.object({ sessionId: cuidSchema }).parse(request.params);
    const body = z.object({ actionIndex: z.number().int().min(0).max(9) }).parse(request.body);

    const session = await prisma.aiSession.findFirst({
      where: { id: sessionId, accountId: account.id },
    });
    if (!session) throw notFound('Session not found.');

    const access = await resolveServerAccess(request, session.serverId);

    const actions = session.proposedActions as Array<{
      kind: ProposedActionKind;
      parameters: Record<string, unknown>;
      rationale: string;
      status: string;
    }>;

    const action = actions[body.actionIndex];
    if (!action) throw notFound('That action is not part of this session.');
    if (action.status !== 'pending') throw badRequest('That action has already been resolved.');

    // Authorisation is re-checked at approval time, not just at proposal time.
    const permission = ACTION_PERMISSION[action.kind] as Permission;
    if (permission !== 'server:read') assertPermission(access, permission);

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AiActionApproved,
      targetType: 'server',
      targetId: session.serverId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { kind: action.kind, rationale: action.rationale.slice(0, 200) },
    });

    const result = await executeAction(session.serverId, action, {
      accountId: account.id,
      username: `${account.username} (via AI assistant)`,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
    });

    actions[body.actionIndex] = { ...action, status: 'approved' };
    await prisma.aiSession.update({
      where: { id: sessionId },
      data: {
        proposedActions: actions as never,
        status: actions.every((a) => a.status !== 'pending') ? 'closed' : 'awaiting_approval',
      },
    });

    return reply.send({ ok: true, result });
  });

  app.post('/ai/sessions/:sessionId/reject', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { sessionId } = z.object({ sessionId: cuidSchema }).parse(request.params);
    const body = z.object({ actionIndex: z.number().int().min(0).max(9) }).parse(request.body);

    const session = await prisma.aiSession.findFirst({
      where: { id: sessionId, accountId: account.id },
    });
    if (!session) throw notFound('Session not found.');

    const actions = session.proposedActions as Array<{ status: string; kind: string }>;
    const action = actions[body.actionIndex];
    if (!action) throw notFound('That action is not part of this session.');

    actions[body.actionIndex] = { ...action, status: 'rejected' };
    await prisma.aiSession.update({
      where: { id: sessionId },
      data: {
        proposedActions: actions as never,
        status: actions.every((a) => a.status !== 'pending') ? 'closed' : 'awaiting_approval',
      },
    });

    await audit({
      accountId: account.id,
      actorLabel: account.username,
      action: AuditAction.AiActionRejected,
      targetType: 'server',
      targetId: session.serverId,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { kind: action.kind },
    });

    return reply.send({ ok: true });
  });

  app.get('/servers/:id/ai/sessions', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:ai');

    const sessions = await prisma.aiSession.findMany({
      where: { serverId: id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    return reply.send({
      sessions: sessions.map((session) => ({
        id: session.id,
        question: session.question,
        status: session.status,
        actions: session.proposedActions,
        createdAt: session.createdAt.toISOString(),
      })),
    });
  });
}

/**
 * Executes an approved action.
 *
 * Every parameter is re-validated here against the same schemas the manual
 * routes use. The model's output is untrusted input no matter how sensible it
 * looked in the proposal, and a human approving "change the config" is not the
 * same as a human approving whatever arbitrary JSON came back.
 */
async function executeAction(
  serverId: string,
  action: { kind: ProposedActionKind; parameters: Record<string, unknown> },
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string },
): Promise<string> {
  const parameters = action.parameters ?? {};

  switch (action.kind) {
    case 'no_action':
      return 'No action was needed.';

    /* ---- Power ---- */

    case 'start_server':
    case 'stop_server':
    case 'restart_server': {
      const map = {
        start_server: 'start',
        stop_server: 'stop',
        restart_server: 'restart',
      } as const;
      const result = await performPowerAction(serverId, map[action.kind], actor);
      return `Server is now ${result.state}.`;
    }

    case 'reinstall_server':
      // Never automated, even on approval - it goes through the normal
      // confirmation flow so the operator types the server name themselves.
      throw forbidden(
        'Reinstalls cannot be triggered from the assistant. Use the Reinstall button, which requires typing the server name.',
      );

    /* ---- Mods ---- */

    case 'add_mod': {
      const server = await loadServer(serverId);
      const gameId = toGameId(server.game);

      const modId = String(parameters.modId ?? '').trim();
      if (!validateModId(gameId, modId)) {
        throw badRequest(`"${modId}" is not a valid mod id for ${GAMES[gameId].name}.`);
      }

      const existing = await getServerMods(serverId);
      if (existing.some((mod) => mod.modId === modId)) {
        return `Mod ${modId} was already on this server; nothing changed.`;
      }

      const name = String(parameters.name ?? `Workshop item ${modId}`)
        .replace(/[<>]/g, '')
        .slice(0, 160);
      const rawVersion = parameters.version;
      const version =
        typeof rawVersion === 'string' && rawVersion.trim() ? rawVersion.trim().slice(0, 32) : null;

      await setServerMods(serverId, [
        ...existing,
        { modId, name, version, enabled: true, order: existing.length, required: false },
      ]);

      return `Added ${name} (${modId}) to the mod list. Restart to apply.`;
    }

    case 'remove_mod': {
      const modId = String(parameters.modId ?? '').trim();
      const existing = await getServerMods(serverId);
      if (!existing.some((mod) => mod.modId === modId)) {
        throw badRequest(`Mod ${modId} is not on this server.`);
      }
      await setServerMods(
        serverId,
        existing.filter((mod) => mod.modId !== modId),
      );
      return `Removed ${modId} from the mod list. Restart to apply.`;
    }

    case 'enable_mod':
    case 'disable_mod': {
      const modId = String(parameters.modId ?? '').trim();
      if (!/^[A-Za-z0-9]{1,64}$/.test(modId)) throw badRequest('The proposed mod id is not valid.');
      await toggleMod(serverId, modId, action.kind === 'enable_mod');
      return `Mod ${modId} ${action.kind === 'enable_mod' ? 'enabled' : 'disabled'}. Restart to apply.`;
    }

    case 'reorder_mods': {
      const order = parameters.order;
      if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        throw badRequest('The proposed mod order is not valid.');
      }
      await reorderMods(serverId, order as string[]);
      return 'Mod load order updated. Restart to apply.';
    }

    /* ---- Game configuration ---- */

    case 'change_config': {
      const server = await loadServer(serverId);
      const adapter = getAdapter(toGameId(server.game));

      const patch = parameters.patch ?? parameters;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw badRequest('The proposed configuration change is not an object.');
      }

      // The adapter's own schema decides what is acceptable. An out-of-range
      // value fails here exactly as it would from the settings screen.
      const config = adapter.validateConfig(patch, server.config as Record<string, unknown>);

      const updated = await prisma.server.update({
        where: { id: serverId },
        data: { config: config as never },
      });
      await adapter.writeConfig(updated).catch(() => undefined);

      const changed = Object.keys(patch as Record<string, unknown>).join(', ');
      return `Configuration updated (${changed}). Restart to apply.`;
    }

    /* ---- Resources ---- */

    case 'increase_memory':
    case 'increase_cpu': {
      const server = await loadServer(serverId);

      const requested = {
        cpuCores: Number(parameters.cpuCores ?? server.cpuCores),
        cpuSet: server.cpuSet,
        memoryMib: Number(parameters.memoryMib ?? server.memoryMib),
        storageGib: server.storageGib,
        bandwidthMbps: server.bandwidthMbps,
        transferQuotaGib: server.transferQuotaGib,
        slots: server.slots,
      };

      const parsed = resourceAllocationSchema.safeParse(requested);
      if (!parsed.success) {
        throw badRequest(
          'The proposed resource change is outside the allowed range.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      // Only ever upward. An "increase" action that shrank an allocation would
      // be a surprising way to lose capacity.
      if (parsed.data.memoryMib < server.memoryMib || parsed.data.cpuCores < server.cpuCores) {
        throw badRequest('That action can only increase resources, not reduce them.');
      }

      // updateResources re-checks real node capacity, so this cannot oversell.
      await updateResources(serverId, parsed.data, actor);

      return `Resources updated to ${parsed.data.cpuCores} cores and ${
        parsed.data.memoryMib / 1024
      } GB. Restart to apply.`;
    }

    /* ---- Files ---- */

    case 'edit_file': {
      const server = await loadServer(serverId);

      const parsed = writeFileSchema.safeParse({
        path: parameters.path,
        content: parameters.content,
      });
      if (!parsed.success) {
        throw badRequest(
          'The proposed file edit is not valid.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      // Same containment and extension allowlist as the manual file manager:
      // the assistant gets no special reach into the filesystem.
      await writeTextFile(server.volumePath, parsed.data.path, parsed.data.content);

      await audit({
        accountId: actor.accountId,
        actorLabel: actor.username,
        action: AuditAction.FileWritten,
        targetType: 'server',
        targetId: serverId,
        ipHash: actor.ipHash,
        userAgentHash: actor.userAgentHash,
        metadata: { path: parsed.data.path, viaAssistant: true },
      });

      return `Wrote ${parsed.data.path}. Restart to apply.`;
    }

    /* ---- Console ---- */

    case 'run_console_command': {
      const server = await loadServer(serverId);
      if (server.state !== 'RUNNING') {
        throw badRequest('The server must be running to send a console command.');
      }

      const parsed = consoleCommandSchema.safeParse({ command: parameters.command });
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'The proposed command is not valid.');
      }

      emitPanelNotice(serverId, `> [${actor.username}] ${parsed.data.command}`);
      const response = await getAdapter(toGameId(server.game)).sendRconCommand(
        server,
        parsed.data.command,
      );
      if (response) emitPanelNotice(serverId, response);

      await audit({
        accountId: actor.accountId,
        actorLabel: actor.username,
        action: AuditAction.ConsoleCommand,
        targetType: 'server',
        targetId: serverId,
        ipHash: actor.ipHash,
        userAgentHash: actor.userAgentHash,
        metadata: { command: parsed.data.command.slice(0, 200), viaAssistant: true },
      });

      return response ? `Command sent. Reply: ${response.slice(0, 500)}` : 'Command sent.';
    }

    default:
      throw badRequest('Unknown action.');
  }
}
