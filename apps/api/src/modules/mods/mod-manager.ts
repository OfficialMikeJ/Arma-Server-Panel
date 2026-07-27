/**
 * Mod management.
 *
 * "Save time managing mods with an awesome mod interface - export presets,
 * change load order, change versions in seconds." That maps to four things:
 * a validated mod list per server, reorderable load order, per-mod version
 * pinning, and preset import/export in the formats people already have.
 *
 * Import parsing is the risky part: an Arma 3 preset is an HTML file a user
 * pastes in. It is never rendered - only scraped for ids with a bounded regex
 * - so it cannot become stored XSS.
 */

import { type ModEntry, type GameId, GAMES } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { safeFetch } from '../../security/ssrf.js';
import { getAdapter } from '../games/registry.js';
import { toGameId, loadServer } from '../servers/server-service.js';
import { emitPanelNotice } from '../servers/console-buffer.js';

const MOD_ID_PATTERNS: Record<GameId, RegExp> = {
  arma3: /^\d{6,12}$/,
  reforger: /^[0-9A-F]{16}$/,
  arma4: /^[0-9A-F]{16}$/,
};

export function validateModId(gameId: GameId, modId: string): boolean {
  return MOD_ID_PATTERNS[gameId].test(modId);
}

/* ------------------------------------------------------------------ */
/* Server mod list                                                     */
/* ------------------------------------------------------------------ */

export async function getServerMods(serverId: string): Promise<ModEntry[]> {
  const rows = await prisma.serverMod.findMany({
    where: { serverId },
    orderBy: { order: 'asc' },
  });
  return rows.map((row) => ({
    modId: row.modId,
    name: row.name,
    version: row.version,
    enabled: row.enabled,
    order: row.order,
    required: row.required,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  }));
}

export async function setServerMods(
  serverId: string,
  mods: Array<Omit<ModEntry, 'sizeBytes'>>,
): Promise<ModEntry[]> {
  const server = await loadServer(serverId);
  const gameId = toGameId(server.game);

  if (GAMES[gameId].modSource === 'none') {
    throw badRequest(`${GAMES[gameId].name} does not support mods through the panel yet.`);
  }

  // Reject bad ids up front so a partial write cannot happen.
  const seen = new Set<string>();
  for (const mod of mods) {
    if (!validateModId(gameId, mod.modId)) {
      throw badRequest(`"${mod.name}" has an id that is not valid for ${GAMES[gameId].name}.`);
    }
    if (seen.has(mod.modId)) {
      throw badRequest(`Mod ${mod.modId} appears more than once.`);
    }
    seen.add(mod.modId);
  }

  // Normalise load order to 0..n-1 so gaps and ties cannot accumulate.
  const ordered = [...mods]
    .sort((a, b) => a.order - b.order)
    .map((mod, index) => ({ ...mod, order: index }));

  // The list is rewritten wholesale, and callers such as toggleMod cannot
  // supply sizeBytes - it comes from the Workshop lookup. Carry the cached
  // value across so flipping a checkbox does not blank every mod's size.
  const existingSizes = new Map(
    (
      await prisma.serverMod.findMany({
        where: { serverId },
        select: { modId: true, sizeBytes: true },
      })
    ).map((row) => [row.modId, row.sizeBytes]),
  );

  await prisma.$transaction(async (tx) => {
    await tx.serverMod.deleteMany({ where: { serverId } });
    if (ordered.length > 0) {
      await tx.serverMod.createMany({
        data: ordered.map((mod) => ({
          serverId,
          modId: mod.modId,
          name: mod.name.slice(0, 160),
          version: mod.version,
          enabled: mod.enabled,
          order: mod.order,
          required: mod.required,
          sizeBytes: existingSizes.get(mod.modId) ?? null,
        })),
      });
    }
  });

  const result = await getServerMods(serverId);

  // Push the new list into the game's native config immediately.
  await getAdapter(gameId).writeMods(server, result);

  emitPanelNotice(
    serverId,
    `Mod list updated: ${result.filter((m) => m.enabled).length} enabled. Restart to apply.`,
  );

  return result;
}

export async function reorderMods(serverId: string, orderedIds: string[]): Promise<ModEntry[]> {
  const existing = await getServerMods(serverId);
  const byId = new Map(existing.map((m) => [m.modId, m]));

  if (orderedIds.length !== existing.length || orderedIds.some((id) => !byId.has(id))) {
    throw badRequest('The reorder request does not match the current mod list.');
  }

  return setServerMods(
    serverId,
    orderedIds.map((id, index) => ({ ...byId.get(id)!, order: index })),
  );
}

export async function setModVersion(
  serverId: string,
  modId: string,
  version: string | null,
): Promise<ModEntry[]> {
  const mods = await getServerMods(serverId);
  const target = mods.find((m) => m.modId === modId);
  if (!target) throw notFound('That mod is not on this server.');

  return setServerMods(
    serverId,
    mods.map((m) => (m.modId === modId ? { ...m, version } : m)),
  );
}

export async function toggleMod(
  serverId: string,
  modId: string,
  enabled: boolean,
): Promise<ModEntry[]> {
  const mods = await getServerMods(serverId);
  if (!mods.some((m) => m.modId === modId)) throw notFound('That mod is not on this server.');

  return setServerMods(
    serverId,
    mods.map((m) => (m.modId === modId ? { ...m, enabled } : m)),
  );
}

/* ------------------------------------------------------------------ */
/* Preset import / export                                              */
/* ------------------------------------------------------------------ */

export type PresetFormat = 'arma3-html' | 'reforger-json' | 'asp-json';

export interface ParsedPreset {
  mods: Array<Omit<ModEntry, 'sizeBytes'>>;
  warnings: string[];
}

/**
 * Parses an Arma 3 Launcher preset export.
 *
 * The file is HTML, but it is treated purely as text: the Steam file id is
 * lifted out of each `?id=NNNN` link and the display name out of the adjacent
 * `<td data-type="DisplayName">`. Nothing from the document is ever emitted
 * back into a page as markup.
 */
export function parseArma3HtmlPreset(payload: string): ParsedPreset {
  const warnings: string[] = [];
  const mods: Array<Omit<ModEntry, 'sizeBytes'>> = [];
  const seen = new Set<string>();

  // Each mod is one <tr data-type="ModContainer"> block.
  const blocks = payload.match(/<tr[^>]*data-type="ModContainer"[\s\S]*?<\/tr>/gi) ?? [];

  for (const block of blocks) {
    const idMatch = /[?&]id=(\d{6,12})/.exec(block);
    if (!idMatch?.[1]) continue;

    const modId = idMatch[1];
    if (seen.has(modId)) continue;
    seen.add(modId);

    const nameMatch = /data-type="DisplayName"[^>]*>([^<]{1,160})</i.exec(block);
    // Strip tags and entities defensively even though this is stored, not rendered.
    const name = (nameMatch?.[1] ?? `Workshop item ${modId}`)
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/[<>]/g, '')
      .trim()
      .slice(0, 160);

    mods.push({
      modId,
      name: name || `Workshop item ${modId}`,
      version: null,
      enabled: true,
      order: mods.length,
      required: false,
    });
  }

  if (mods.length === 0) {
    warnings.push('No Steam Workshop mods were found in that preset file.');
  }
  if (blocks.length > mods.length) {
    warnings.push(`${blocks.length - mods.length} entries were skipped because they had no Workshop id.`);
  }

  return { mods, warnings };
}

/** Parses a Reforger `config.json` or a bare mod array. */
export function parseReforgerJsonPreset(payload: string): ParsedPreset {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    throw badRequest('That is not valid JSON.');
  }

  const candidates =
    Array.isArray(parsed)
      ? parsed
      : ((parsed as { game?: { mods?: unknown[] }; mods?: unknown[] })?.game?.mods ??
        (parsed as { mods?: unknown[] })?.mods ??
        []);

  if (!Array.isArray(candidates)) {
    throw badRequest('No mod list was found in that file.');
  }

  const mods: Array<Omit<ModEntry, 'sizeBytes'>> = [];
  const seen = new Set<string>();

  for (const entry of candidates.slice(0, 512)) {
    const record = entry as { modId?: unknown; name?: unknown; version?: unknown; required?: unknown };
    const modId = String(record.modId ?? '').toUpperCase();

    if (!/^[0-9A-F]{16}$/.test(modId)) {
      warnings.push(`Skipped an entry with an invalid mod id.`);
      continue;
    }
    if (seen.has(modId)) continue;
    seen.add(modId);

    mods.push({
      modId,
      name: String(record.name ?? `Workshop item ${modId}`).replace(/[<>]/g, '').slice(0, 160),
      version: record.version ? String(record.version).slice(0, 32) : null,
      enabled: true,
      order: mods.length,
      required: Boolean(record.required),
    });
  }

  return { mods, warnings };
}

export function parsePreset(format: PresetFormat, payload: string): ParsedPreset {
  switch (format) {
    case 'arma3-html':
      return parseArma3HtmlPreset(payload);
    case 'reforger-json':
      return parseReforgerJsonPreset(payload);
    case 'asp-json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw badRequest('That is not valid JSON.');
      }
      const mods = (parsed as { mods?: unknown[] })?.mods;
      if (!Array.isArray(mods)) throw badRequest('No mod list was found in that file.');
      return {
        mods: mods.slice(0, 512).map((entry, index) => {
          const record = entry as Record<string, unknown>;
          return {
            modId: String(record.modId ?? '').slice(0, 64),
            name: String(record.name ?? '').replace(/[<>]/g, '').slice(0, 160),
            version: record.version ? String(record.version).slice(0, 32) : null,
            enabled: record.enabled !== false,
            order: index,
            required: Boolean(record.required),
          };
        }),
        warnings: [],
      };
    }
    default:
      throw badRequest('Unsupported preset format.');
  }
}

/** Panel-native export. Round-trips through `asp-json`. */
export function exportPreset(name: string, gameId: GameId, mods: ModEntry[]): string {
  return JSON.stringify(
    {
      format: 'arma-server-panel-preset',
      version: 1,
      name,
      game: gameId,
      exportedAt: new Date().toISOString(),
      mods: mods.map((m) => ({
        modId: m.modId,
        name: m.name,
        version: m.version,
        enabled: m.enabled,
        required: m.required,
      })),
    },
    null,
    2,
  );
}

/** Arma 3 Launcher-compatible export, so presets work in the official launcher. */
export function exportArma3Html(name: string, mods: ModEntry[]): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const rows = mods
    .filter((m) => m.enabled)
    .map(
      (mod) =>
        `<tr data-type="ModContainer">\n` +
        `<td data-type="DisplayName">${escape(mod.name)}</td>\n` +
        `<td><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(mod.modId)}" data-type="Link">` +
        `https://steamcommunity.com/sharedfiles/filedetails/?id=${escape(mod.modId)}</a></td>\n` +
        `</tr>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<html>',
    '<head><meta name="arma:Type" content="preset" />',
    `<meta name="arma:PresetName" content="${escape(name)}" />`,
    `<title>Arma 3 - Preset ${escape(name)}</title></head>`,
    '<body>',
    `<h1>Arma 3 - Preset <strong>${escape(name)}</strong></h1>`,
    '<table>',
    rows,
    '</table>',
    '</body></html>',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Workshop metadata                                                   */
/* ------------------------------------------------------------------ */

export interface WorkshopItem {
  modId: string;
  name: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  found: boolean;
}

/**
 * Looks up Steam Workshop metadata so the UI can show real names and sizes
 * rather than bare ids. Failure is non-fatal - a mod can be added without it.
 */
export async function lookupSteamWorkshop(modIds: string[]): Promise<WorkshopItem[]> {
  const ids = modIds.filter((id) => /^\d{6,12}$/.test(id)).slice(0, 50);
  if (ids.length === 0) return [];

  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, index) => body.append(`publishedfileids[${index}]`, id));

  try {
    const response = await safeFetch(
      'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        allowedHosts: ['api.steampowered.com'],
        timeoutMs: 8000,
      },
    );

    if (response.status !== 200) return ids.map(notFoundItem);

    const parsed = JSON.parse(response.body) as {
      response?: { publishedfiledetails?: Array<Record<string, unknown>> };
    };
    const details = parsed.response?.publishedfiledetails ?? [];

    return ids.map((id) => {
      const detail = details.find((d) => String(d.publishedfileid) === id);
      if (!detail || Number(detail.result) !== 1) return notFoundItem(id);
      return {
        modId: id,
        name: String(detail.title ?? `Workshop item ${id}`).replace(/[<>]/g, '').slice(0, 160),
        sizeBytes: detail.file_size ? Number(detail.file_size) : null,
        updatedAt: detail.time_updated
          ? new Date(Number(detail.time_updated) * 1000).toISOString()
          : null,
        found: true,
      };
    });
  } catch (error) {
    logger.warn({ err: error }, 'Steam Workshop lookup failed');
    return ids.map(notFoundItem);
  }
}

function notFoundItem(modId: string): WorkshopItem {
  return { modId, name: `Workshop item ${modId}`, sizeBytes: null, updatedAt: null, found: false };
}
