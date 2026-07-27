/**
 * The registry of games the panel can install.
 *
 * Two sources, resolved in one place:
 *
 *   * The three built-in titles, derived from the compiled GAMES table. They
 *     exist as definitions so there is a single code path, and are marked
 *     built-in so they cannot be deleted out from under a running server.
 *   * Definitions uploaded by an administrator, stored in the database.
 *
 * An uploaded definition with the same id as a built-in overrides it. That is
 * how an operator points a title at a different image or beta branch without
 * waiting for a panel release - and why built-ins are re-derivable, so removing
 * the override restores the shipped behaviour exactly.
 *
 * Everything is re-validated on read. A definition that was valid when uploaded
 * may not be after a panel upgrade tightens the schema, and running against a
 * document that no longer passes is worse than refusing it.
 */

import { GAMES, validateGameDefinition, type GameDefinition, type GameId } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * The shipped titles, expressed in the definition format.
 *
 * Derived rather than duplicated: the compiled GAMES table stays the source of
 * truth for the three titles the adapters support, so the two cannot drift.
 */
export function builtInDefinitions(): GameDefinition[] {
  const binaries: Record<GameId, string> = {
    arma3: 'arma3server_x64',
    reforger: 'ArmaReforgerServer',
    arma4: 'ArmaReforgerServer',
  };

  return (Object.keys(GAMES) as GameId[]).map((id) => {
    const game = GAMES[id];
    const result = validateGameDefinition({
      id,
      name: game.name,
      shortName: game.shortName,
      version: '1',
      author: 'Arma Server Panel',
      description: `Built-in definition for ${game.name}.`,
      install: {
        image: game.image,
        steamAppId: game.steamAppId ?? 1,
        steamGameAppId: game.steamGameAppId,
        requiresSteamLogin: game.requiresSteamLogin,
        validate: true,
        binary: binaries[id],
      },
      startup: {
        // The built-in images carry their own entrypoint, which already knows
        // how to launch its game. Arguments stay empty rather than duplicating
        // that logic in two places where they could disagree.
        arguments: [],
        stopTimeoutSeconds: 30,
      },
      ports: game.ports.map((port) => ({
        key: port.key,
        label: port.label,
        protocol: port.protocol,
        offset: port.offset,
        public: port.public,
        optional: port.optional ?? false,
      })),
      portStride: game.portBlock.stride,
      resources: {
        minMemoryMib: game.memoryMib.min,
        recommendedMemoryMib: game.memoryMib.recommended,
        minCpuCores: game.cpu.min,
        minStorageGib: game.storageGib.min,
      },
      defaultSlots: game.defaultSlots,
      maxSlots: game.maxSlots,
      adapter: id,
    });

    if (!result.definition) {
      // A built-in that fails its own schema is a bug in the panel, not in
      // anyone's data, and should not be papered over.
      throw new Error(
        `Built-in definition for ${id} is invalid: ${result.problems
          .map((p) => `${p.path}: ${p.message}`)
          .join('; ')}`,
      );
    }
    return result.definition;
  });
}

/** Slugs the Server.game enum can actually hold. */
const GAME_TITLE_BY_SLUG: Record<string, 'ARMA3' | 'REFORGER' | 'ARMA4' | undefined> = {
  arma3: 'ARMA3',
  reforger: 'REFORGER',
  arma4: 'ARMA4',
};

export interface StoredDefinition {
  definition: GameDefinition;
  builtIn: boolean;
  enabled: boolean;
  /** True when an upload is shadowing a built-in of the same id. */
  overridesBuiltIn: boolean;
  uploadedBy: string | null;
  updatedAt: string | null;
}

/** Every definition the panel knows about, uploads taking precedence. */
export async function listDefinitions(): Promise<StoredDefinition[]> {
  const builtIns = new Map(builtInDefinitions().map((d) => [d.id, d]));

  const rows = await prisma.gameDefinition.findMany({
    include: { uploadedBy: { select: { username: true } } },
    orderBy: { slug: 'asc' },
  });

  const result: StoredDefinition[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const validation = validateGameDefinition(row.definition);
    if (!validation.definition) {
      // Kept visible rather than dropped: an operator needs to be told which
      // of their definitions stopped validating, not left wondering where a
      // game went.
      logger.warn(
        { slug: row.slug, problems: validation.problems },
        'Stored game definition no longer validates and is being ignored',
      );
      continue;
    }

    seen.add(row.slug);
    result.push({
      definition: validation.definition,
      builtIn: builtIns.has(row.slug),
      enabled: row.enabled,
      overridesBuiltIn: builtIns.has(row.slug),
      uploadedBy: row.uploadedBy?.username ?? null,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  for (const [id, definition] of builtIns) {
    if (seen.has(id)) continue;
    result.push({
      definition,
      builtIn: true,
      enabled: true,
      overridesBuiltIn: false,
      uploadedBy: null,
      updatedAt: null,
    });
  }

  return result.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

/** Definitions a server may actually be created from. */
export async function availableDefinitions(): Promise<GameDefinition[]> {
  const all = await listDefinitions();
  return all.filter((entry) => entry.enabled).map((entry) => entry.definition);
}

export async function getDefinition(slug: string): Promise<GameDefinition> {
  const all = await listDefinitions();
  const found = all.find((entry) => entry.definition.id === slug);
  if (!found) throw notFound(`No game definition with the id "${slug}".`);
  return found.definition;
}

/** Null rather than throwing, for callers that can carry on without one. */
export async function findDefinition(slug: string): Promise<GameDefinition | null> {
  const all = await listDefinitions();
  return all.find((entry) => entry.definition.id === slug)?.definition ?? null;
}

export async function saveDefinition(
  input: unknown,
  actorId: string,
): Promise<{ definition: GameDefinition; warnings: string[] }> {
  const validation = validateGameDefinition(input);
  if (!validation.definition) {
    throw badRequest(
      'That game definition is not valid.',
      validation.problems.map((problem) => ({ path: problem.path, message: problem.message })),
    );
  }

  const definition = validation.definition;

  await prisma.gameDefinition.upsert({
    where: { slug: definition.id },
    create: {
      slug: definition.id,
      name: definition.name,
      version: definition.version,
      definition: definition as unknown as object,
      builtIn: false,
      enabled: true,
      uploadedById: actorId,
    },
    update: {
      name: definition.name,
      version: definition.version,
      definition: definition as unknown as object,
      uploadedById: actorId,
    },
  });

  logger.info({ slug: definition.id, version: definition.version }, 'Game definition saved');
  return { definition, warnings: validation.warnings };
}

export async function setDefinitionEnabled(slug: string, enabled: boolean): Promise<void> {
  const builtIn = builtInDefinitions().some((d) => d.id === slug);
  const existing = await prisma.gameDefinition.findUnique({ where: { slug } });

  if (!existing && !builtIn) throw notFound(`No game definition with the id "${slug}".`);

  if (!existing) {
    // Disabling a built-in that has no row yet means writing one, so the state
    // survives a restart. It is stored as the built-in's own document, so
    // re-enabling restores exactly what shipped.
    const definition = builtInDefinitions().find((d) => d.id === slug)!;
    await prisma.gameDefinition.create({
      data: {
        slug,
        name: definition.name,
        version: definition.version,
        definition: definition as unknown as object,
        builtIn: true,
        enabled,
      },
    });
    return;
  }

  await prisma.gameDefinition.update({ where: { slug }, data: { enabled } });
}

/**
 * Removes an uploaded definition.
 *
 * A built-in cannot be deleted, only disabled - deleting one would take a game
 * away that servers may still be running on. Deleting an override restores the
 * built-in it was shadowing.
 */
export async function deleteDefinition(slug: string): Promise<{ revertedToBuiltIn: boolean }> {
  const existing = await prisma.gameDefinition.findUnique({ where: { slug } });
  if (!existing) throw notFound(`No game definition with the id "${slug}".`);

  const isBuiltIn = builtInDefinitions().some((d) => d.id === slug);

  // Servers record their game as the compiled enum, so only a built-in id can
  // match. An uploaded definition for a title the enum does not know cannot
  // have servers yet, which is what the zero here means.
  const enumTitle = GAME_TITLE_BY_SLUG[slug];
  const inUse = enumTitle
    ? await prisma.server.count({ where: { game: enumTitle, deletedAt: null } })
    : 0;

  if (inUse > 0 && !isBuiltIn) {
    throw badRequest(
      `${inUse} server${inUse === 1 ? '' : 's'} still use this definition. Delete them first, or disable the definition instead.`,
    );
  }

  await prisma.gameDefinition.delete({ where: { slug } });
  return { revertedToBuiltIn: isBuiltIn };
}
