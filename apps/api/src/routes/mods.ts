import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createModPresetSchema,
  cuidSchema,
  importModPresetSchema,
  modEntrySchema,
  setModsSchema,
  type GameId,
} from '@asp/shared';

import { prisma } from '../db/client.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { loadServer, toGameId } from '../modules/servers/server-service.js';
import {
  exportArma3Html,
  exportPreset,
  getServerMods,
  lookupSteamWorkshop,
  parsePreset,
  reorderMods,
  setModVersion,
  setServerMods,
  toggleMod,
  validateModId,
} from '../modules/mods/mod-manager.js';

const GAME_TITLE: Record<GameId, 'ARMA3' | 'REFORGER' | 'ARMA4'> = {
  arma3: 'ARMA3',
  reforger: 'REFORGER',
  arma4: 'ARMA4',
};

export async function registerModRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /* ---- Server mod list ---- */

  app.get('/servers/:id/mods', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:read');

    const server = await loadServer(id);
    return reply.send({ mods: await getServerMods(id), game: toGameId(server.game) });
  });

  app.put('/servers/:id/mods', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const body = setModsSchema.parse(request.body);
    const mods = await setServerMods(id, body.mods);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.ModsChanged,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { count: mods.length, enabled: mods.filter((m) => m.enabled).length },
    });

    return reply.send({ mods });
  });

  /** Adds one mod without resending the whole list. */
  app.post('/servers/:id/mods', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const body = modEntrySchema.partial({ order: true }).parse(request.body);
    const server = await loadServer(id);
    const gameId = toGameId(server.game);

    if (!validateModId(gameId, body.modId)) {
      throw badRequest(`That mod id is not valid for ${gameId === 'arma3' ? 'Arma 3' : 'Reforger'}.`);
    }

    const existing = await getServerMods(id);
    if (existing.some((m) => m.modId === body.modId)) {
      throw badRequest('That mod is already on this server.');
    }

    const mods = await setServerMods(id, [
      ...existing,
      { ...body, order: existing.length, version: body.version ?? null },
    ]);

    return reply.status(201).send({ mods });
  });

  app.delete('/servers/:id/mods/:modId', guard, async (request, reply) => {
    const { id, modId } = z
      .object({ id: cuidSchema, modId: z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/) })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const existing = await getServerMods(id);
    if (!existing.some((m) => m.modId === modId)) throw notFound('That mod is not on this server.');

    const mods = await setServerMods(
      id,
      existing.filter((m) => m.modId !== modId),
    );
    return reply.send({ mods });
  });

  /* ---- Load order and versions: "change load order, change versions in seconds" ---- */

  app.post('/servers/:id/mods/reorder', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const body = z
      .object({ order: z.array(z.string().min(1).max(64)).max(512) })
      .parse(request.body);

    return reply.send({ mods: await reorderMods(id, body.order) });
  });

  app.patch('/servers/:id/mods/:modId', guard, async (request, reply) => {
    const { id, modId } = z
      .object({ id: cuidSchema, modId: z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/) })
      .parse(request.params);

    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const body = z
      .object({
        enabled: z.boolean().optional(),
        version: z.string().max(32).nullable().optional(),
      })
      .parse(request.body);

    let mods = await getServerMods(id);
    if (body.enabled !== undefined) mods = await toggleMod(id, modId, body.enabled);
    if (body.version !== undefined) mods = await setModVersion(id, modId, body.version);

    return reply.send({ mods });
  });

  /* ---- Workshop metadata ---- */

  app.post('/mods/lookup', guard, async (request, reply) => {
    const body = z
      .object({
        game: z.enum(['arma3', 'reforger', 'arma4']),
        modIds: z.array(z.string().min(1).max(64)).min(1).max(50),
      })
      .parse(request.body);

    if (body.game !== 'arma3') {
      // Reforger's workshop has no public metadata API; return the ids as-is
      // rather than pretending to have looked them up.
      return reply.send({
        items: body.modIds.map((modId) => ({
          modId,
          name: `Workshop item ${modId}`,
          sizeBytes: null,
          updatedAt: null,
          found: false,
        })),
        note: 'Reforger Workshop metadata is not publicly queryable. Names can be edited by hand.',
      });
    }

    return reply.send({ items: await lookupSteamWorkshop(body.modIds) });
  });

  /* ---- Presets: "export presets" ---- */

  app.get('/mod-presets', guard, async (request, reply) => {
    const account = request.auth.account!;
    const query = z
      .object({ game: z.enum(['arma3', 'reforger', 'arma4']).optional() })
      .parse(request.query ?? {});

    const presets = await prisma.modPreset.findMany({
      where: { ownerId: account.id, ...(query.game ? { game: GAME_TITLE[query.game] } : {}) },
      orderBy: { updatedAt: 'desc' },
    });

    return reply.send({
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        game: toGameId(preset.game),
        modCount: Array.isArray(preset.mods) ? preset.mods.length : 0,
        createdAt: preset.createdAt.toISOString(),
        updatedAt: preset.updatedAt.toISOString(),
      })),
    });
  });

  app.post('/mod-presets', guard, async (request, reply) => {
    const account = request.auth.account!;
    const body = createModPresetSchema.parse(request.body);

    for (const mod of body.mods) {
      if (!validateModId(body.game, mod.modId)) {
        throw badRequest(`"${mod.name}" has an id that is not valid for this game.`);
      }
    }

    const preset = await prisma.modPreset.create({
      data: {
        name: body.name,
        game: GAME_TITLE[body.game],
        ownerId: account.id,
        mods: body.mods as never,
      },
    });

    return reply.status(201).send({ preset: { id: preset.id, name: preset.name } });
  });

  app.post('/mod-presets/import', guard, async (request, reply) => {
    const account = request.auth.account!;
    const body = importModPresetSchema.parse(request.body);

    const parsed = parsePreset(body.format, body.payload);

    const invalid = parsed.mods.filter((mod) => !validateModId(body.game, mod.modId));
    const valid = parsed.mods.filter((mod) => validateModId(body.game, mod.modId));

    if (valid.length === 0) {
      throw badRequest('No usable mods were found in that preset.');
    }

    const preset = await prisma.modPreset.create({
      data: {
        name: body.name,
        game: GAME_TITLE[body.game],
        ownerId: account.id,
        mods: valid as never,
      },
    });

    return reply.status(201).send({
      preset: { id: preset.id, name: preset.name, modCount: valid.length },
      warnings: [
        ...parsed.warnings,
        ...(invalid.length > 0
          ? [`${invalid.length} entries were skipped because their ids are not valid for this game.`]
          : []),
      ],
    });
  });

  app.get('/mod-presets/:presetId/export', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { presetId } = z.object({ presetId: cuidSchema }).parse(request.params);
    const query = z.object({ format: z.enum(['asp-json', 'arma3-html']).default('asp-json') }).parse(
      request.query ?? {},
    );

    const preset = await prisma.modPreset.findFirst({
      where: { id: presetId, ownerId: account.id },
    });
    if (!preset) throw notFound('Preset not found.');

    const gameId = toGameId(preset.game);
    const mods = preset.mods as unknown as Parameters<typeof exportPreset>[2];

    if (query.format === 'arma3-html') {
      if (gameId !== 'arma3') throw badRequest('HTML export is only available for Arma 3 presets.');
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-disposition', `attachment; filename="${sanitizeFilename(preset.name)}.html"`)
        .send(exportArma3Html(preset.name, mods));
    }

    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${sanitizeFilename(preset.name)}.json"`)
      .send(exportPreset(preset.name, gameId, mods));
  });

  app.post('/servers/:id/mods/apply-preset', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:mods');

    const body = z
      .object({ presetId: cuidSchema, mode: z.enum(['replace', 'append']).default('replace') })
      .parse(request.body);

    const preset = await prisma.modPreset.findFirst({
      where: { id: body.presetId, ownerId: account.id },
    });
    if (!preset) throw notFound('Preset not found.');

    const server = await loadServer(id);
    if (toGameId(server.game) !== toGameId(preset.game)) {
      throw badRequest('That preset is for a different game.');
    }

    const presetMods = preset.mods as Array<{
      modId: string;
      name: string;
      version: string | null;
      enabled: boolean;
      required: boolean;
    }>;

    const existing = body.mode === 'append' ? await getServerMods(id) : [];
    const seen = new Set(existing.map((m) => m.modId));

    const combined = [
      ...existing,
      ...presetMods
        .filter((mod) => !seen.has(mod.modId))
        .map((mod, index) => ({ ...mod, order: existing.length + index })),
    ];

    return reply.send({ mods: await setServerMods(id, combined) });
  });

  app.delete('/mod-presets/:presetId', guard, async (request, reply) => {
    const account = request.auth.account!;
    const { presetId } = z.object({ presetId: cuidSchema }).parse(request.params);

    const deleted = await prisma.modPreset.deleteMany({
      where: { id: presetId, ownerId: account.id },
    });
    if (deleted.count === 0) throw notFound('Preset not found.');

    return reply.send({ ok: true });
  });
}

/** Content-Disposition filenames must not contain quotes, slashes or CR/LF. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'preset';
}
