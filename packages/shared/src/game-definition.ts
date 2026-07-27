/**
 * Game definitions.
 *
 * A definition describes how to obtain and launch one game's dedicated server,
 * as data rather than as a Dockerfile baked into the panel. Adding a game means
 * adding one of these, not editing the panel.
 *
 * Deliberately *declarative*, which is the main departure from the egg format
 * this borrows from. A Pterodactyl egg carries a bash install script and runs
 * it in a container; that is remote code execution wearing a config file, and
 * an uploaded one would let anyone with the upload permission run anything they
 * liked on the host. Here the install is described - app id, whether it needs a
 * login, which file to expect afterwards - and the panel's own entrypoint
 * performs it. There is no field an attacker can put a shell command in.
 *
 * The same reasoning shapes the startup: an argument *list* with placeholders
 * from a fixed set, never a string handed to a shell. `; rm -rf /` in an
 * argument is an argument, not a second command.
 *
 * What a definition does NOT own: config file generation, server queries, RCON,
 * and mod handling. Those stay in the adapters, because they are protocol work
 * that JSON cannot express - Arma 3's server.cfg syntax, A2S, BattlEye's CRC32
 * framing. A definition without an adapter still installs and runs; it just
 * gets generic handling for the rest.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Placeholders                                                        */
/* ------------------------------------------------------------------ */

/**
 * Substitutions allowed in a startup argument.
 *
 * A closed set, resolved by the panel from values it already knows. A
 * definition cannot invent one, and cannot reach anything not listed here.
 */
export const STARTUP_PLACEHOLDERS = [
  'binary',
  'gamePort',
  'queryPort',
  'rconPort',
  'serverDir',
  'gameDir',
  'configDir',
  'configFile',
  'profileDir',
  'modsDir',
  'slots',
  'maxFps',
] as const;

export type StartupPlaceholder = (typeof STARTUP_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** Every placeholder used in a string, whether or not it is a known one. */
export function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!);
}

export function resolvePlaceholders(
  value: string,
  values: Partial<Record<StartupPlaceholder, string | number>>,
): string {
  return value.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const replacement = values[name as StartupPlaceholder];
    return replacement === undefined ? whole : String(replacement);
  });
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * Container images a definition may name.
 *
 * Restricted to images the panel builds itself. Pulling an arbitrary image is
 * the other half of the code-execution problem: the install script is gone, but
 * an attacker-chosen image has its own entrypoint and would run just as
 * happily. Operators who genuinely want a third-party image can widen this on
 * their own deployment - it is a deliberate decision, not an oversight.
 */
export const ALLOWED_IMAGE_PREFIXES = ['asp/'] as const;

const imageSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9._-]+)?$/, 'Not a valid image reference')
  .refine(
    (value) => ALLOWED_IMAGE_PREFIXES.some((prefix) => value.startsWith(prefix)),
    `Images must be ones the panel builds (${ALLOWED_IMAGE_PREFIXES.join(', ')}).`,
  );

/**
 * A startup argument.
 *
 * No shell metacharacters, because there is no shell - the list is passed to
 * exec directly. The restriction is belt and braces, and it also keeps a
 * definition readable.
 */
const startupArgumentSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\n\r\0`$|&;<>()]*$/, 'Startup arguments cannot contain shell metacharacters')
  .refine(
    (value) =>
      placeholdersIn(value).every((name) =>
        (STARTUP_PLACEHOLDERS as readonly string[]).includes(name),
      ),
    (value) => ({
      message:
        `Unknown placeholder: ${placeholdersIn(value)
          .filter((name) => !(STARTUP_PLACEHOLDERS as readonly string[]).includes(name))
          .join(', ')}. Available: ${STARTUP_PLACEHOLDERS.join(', ')}`,
    }),
  );

const portSpecSchema = z.object({
  key: z.string().min(1).max(24).regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Port keys are alphanumeric'),
  label: z.string().min(1).max(48),
  protocol: z.enum(['udp', 'tcp']),
  offset: z.number().int().min(0).max(99),
  /**
   * Whether players connect to it. Non-public ports are bound where only the
   * panel and the host can reach them, so a definition cannot publish an
   * administrative port to the internet by mislabelling it.
   */
  public: z.boolean(),
  optional: z.boolean().default(false),
});

export const gameDefinitionSchema = z.object({
  /** Stable identifier. Also the directory name under the data root. */
  id: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, 'Ids are lowercase letters, digits and hyphens'),
  name: z.string().trim().min(1).max(64),
  shortName: z.string().trim().min(1).max(24),
  /** Bumped by whoever maintains the definition. Shown, never interpreted. */
  version: z.string().trim().min(1).max(24).default('1'),
  author: z.string().trim().max(64).default(''),
  description: z.string().trim().max(500).default(''),

  install: z.object({
    image: imageSchema,
    /** Steam application id of the dedicated server package. */
    steamAppId: z.number().int().min(1).max(99_999_999),
    /** Steam app id of the base game, for Workshop lookups. */
    steamGameAppId: z.number().int().min(1).max(99_999_999).nullable().default(null),
    /**
     * True when the package is paid and needs an account that owns it. The
     * panel refuses to provision such a game until Steam credentials are set,
     * rather than letting SteamCMD fail with an anonymous login.
     */
    requiresSteamLogin: z.boolean().default(false),
    /** Optional Steam beta branch, e.g. "creatordlc". */
    branch: z.string().trim().max(64).nullable().default(null),
    branchPassword: z.string().trim().max(64).nullable().default(null),
    /** Re-verify files on every install. Slower, catches corruption. */
    validate: z.boolean().default(true),
    /**
     * Path of the server executable, relative to the game directory. Its
     * presence is how the panel knows the download succeeded.
     */
    binary: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Not a valid relative path')
      .refine((value) => !value.includes('..'), 'Paths cannot traverse upwards'),
  }),

  startup: z.object({
    /** Passed to exec as a list. There is no shell. */
    arguments: z.array(startupArgumentSchema).max(64).default([]),
    /** Seconds to allow for a graceful stop before the container is killed. */
    stopTimeoutSeconds: z.number().int().min(1).max(300).default(30),
  }),

  ports: z.array(portSpecSchema).min(1).max(16),
  /**
   * Distance between consecutive servers of this game. Arma 3 needs 100; most
   * games need only as many ports as they declare.
   */
  portStride: z.number().int().min(1).max(1000).default(10),

  resources: z.object({
    minMemoryMib: z.number().int().min(512).max(262_144),
    recommendedMemoryMib: z.number().int().min(512).max(262_144),
    minCpuCores: z.number().min(0.5).max(64),
    minStorageGib: z.number().int().min(1).max(4096),
  }),

  defaultSlots: z.number().int().min(1).max(1000).default(32),
  maxSlots: z.number().int().min(1).max(1000).default(64),

  /**
   * Adapter that handles config generation, queries and RCON for this game.
   *
   * Omitted means generic handling: the server installs and runs, but the panel
   * writes no game-specific config and cannot report a player count. Cannot
   * name an adapter that does not exist.
   */
  adapter: z.enum(['arma3', 'reforger', 'arma4']).nullable().default(null),
});

export type GameDefinitionInput = z.input<typeof gameDefinitionSchema>;
export type GameDefinition = z.output<typeof gameDefinitionSchema>;

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

export interface DefinitionProblem {
  path: string;
  message: string;
}

export interface DefinitionValidation {
  valid: boolean;
  definition: GameDefinition | null;
  problems: DefinitionProblem[];
  /** Things worth saying that are not failures. */
  warnings: string[];
}

/**
 * Parses and sanity-checks a definition.
 *
 * Separate from the raw zod parse because several of the useful checks are
 * cross-field - a port span wider than the stride, a binary the startup never
 * mentions - and reporting them together beats one round trip per mistake.
 */
export function validateGameDefinition(input: unknown): DefinitionValidation {
  const parsed = gameDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      definition: null,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const definition = parsed.data;
  const problems: DefinitionProblem[] = [];
  const warnings: string[] = [];

  const keys = definition.ports.map((port) => port.key);
  if (new Set(keys).size !== keys.length) {
    problems.push({ path: 'ports', message: 'Two ports share the same key.' });
  }

  const offsets = definition.ports.map((port) => port.offset);
  if (new Set(offsets).size !== offsets.length) {
    problems.push({ path: 'ports', message: 'Two ports share the same offset.' });
  }

  if (!keys.includes('game')) {
    problems.push({
      path: 'ports',
      message: 'One port must be keyed "game" - it is the address players connect to.',
    });
  }

  const span = Math.max(...offsets) + 1;
  if (span > definition.portStride) {
    problems.push({
      path: 'portStride',
      message: `The ports span ${span} but the stride is ${definition.portStride}, so two servers of this game would overlap.`,
    });
  }

  if (definition.resources.recommendedMemoryMib < definition.resources.minMemoryMib) {
    problems.push({
      path: 'resources.recommendedMemoryMib',
      message: 'Recommended memory is below the minimum.',
    });
  }

  if (definition.maxSlots < definition.defaultSlots) {
    problems.push({ path: 'maxSlots', message: 'Maximum slots is below the default.' });
  }

  if (definition.startup.arguments.length === 0) {
    warnings.push('No startup arguments: the image will be launched with none.');
  }
  if (!definition.adapter) {
    warnings.push(
      'No adapter, so the panel will not write a config file, query the player count, or speak RCON for this game. It will still install and run.',
    );
  }
  if (definition.install.branchPassword && !definition.install.branch) {
    warnings.push('A branch password is set but no branch, so it will not be used.');
  }

  return {
    valid: problems.length === 0,
    definition: problems.length === 0 ? definition : null,
    problems,
    warnings,
  };
}
