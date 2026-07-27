/**
 * Game definition administration.
 *
 * Uploading a definition decides what image runs and what arguments it gets, so
 * every write here is behind `panel:settings` and an elevated session. The
 * format itself is what keeps that from being remote code execution: there is
 * no install script, images are restricted to ones the panel builds, and
 * startup arguments are a list rather than a shell string.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { STARTUP_PLACEHOLDERS, validateGameDefinition } from '@asp/shared';
import { audit, AuditAction } from '../security/audit.js';
import {
  deleteDefinition,
  listDefinitions,
  saveDefinition,
  setDefinitionEnabled,
} from '../modules/games/definitions.js';

const slugParam = z.object({
  slug: z.string().min(2).max(32).regex(/^[a-z][a-z0-9-]*$/),
});

export async function registerGameDefinitionRoutes(app: FastifyInstance): Promise<void> {
  const settingsGuard = { onRequest: [app.requirePanelPermission('panel:settings')] };
  const userGuard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /** What a server can be created from. Visible to anyone who can create one. */
  app.get('/game-definitions', userGuard, async (_request, reply) => {
    const all = await listDefinitions();
    return reply.send({
      games: all
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          id: entry.definition.id,
          name: entry.definition.name,
          shortName: entry.definition.shortName,
          description: entry.definition.description,
          requiresSteamLogin: entry.definition.install.requiresSteamLogin,
          resources: entry.definition.resources,
          defaultSlots: entry.definition.defaultSlots,
          maxSlots: entry.definition.maxSlots,
          hasAdapter: entry.definition.adapter !== null,
        })),
    });
  });

  app.get('/admin/game-definitions', settingsGuard, async (_request, reply) => {
    const all = await listDefinitions();
    return reply.send({
      definitions: all.map((entry) => ({
        ...entry,
        // The whole document, so the admin screen can show it for editing.
        definition: entry.definition,
      })),
      // Sent with the list so the UI can document the format without hard-coding
      // a copy of it that would drift.
      placeholders: STARTUP_PLACEHOLDERS,
    });
  });

  /**
   * Checks a definition without storing it.
   *
   * Exists so the upload box can say what is wrong while someone is still
   * editing, rather than only on submit.
   */
  app.post('/admin/game-definitions/validate', settingsGuard, async (request, reply) => {
    const result = validateGameDefinition(request.body);
    return reply.send({
      valid: result.valid,
      problems: result.problems,
      warnings: result.warnings,
    });
  });

  app.post('/admin/game-definitions', settingsGuard, async (request, reply) => {
    const actor = request.auth.account!;
    const { definition, warnings } = await saveDefinition(request.body, actor.id);

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.GameDefinitionSaved,
      targetType: 'game',
      targetId: definition.id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: {
        version: definition.version,
        image: definition.install.image,
        adapter: definition.adapter,
      },
    });

    return reply.status(201).send({ definition, warnings });
  });

  app.patch('/admin/game-definitions/:slug', settingsGuard, async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const actor = request.auth.account!;

    await setDefinitionEnabled(slug, enabled);

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.GameDefinitionSaved,
      targetType: 'game',
      targetId: slug,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { enabled },
    });

    return reply.send({ ok: true });
  });

  app.delete('/admin/game-definitions/:slug', settingsGuard, async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const actor = request.auth.account!;

    const result = await deleteDefinition(slug);

    await audit({
      accountId: actor.id,
      actorLabel: actor.username,
      action: AuditAction.GameDefinitionDeleted,
      targetType: 'game',
      targetId: slug,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: result,
    });

    return reply.send({
      ok: true,
      ...result,
      message: result.revertedToBuiltIn
        ? 'The override was removed. This game is back to the definition that ships with the panel.'
        : 'Definition removed.',
    });
  });
}
