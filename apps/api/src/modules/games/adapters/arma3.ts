/**
 * Arma 3 dedicated server adapter.
 *
 * Config is Arma's own `.cfg` format, which is a C-like key/value syntax. It
 * is generated from a validated object - never by concatenating user strings -
 * and every string value is escaped, because a server name containing a quote
 * or newline would otherwise let a user inject arbitrary config directives.
 *
 * The layout follows a stock Arma 3 server.cfg: the same parameters, spellings
 * and section order. Arma silently ignores keys it does not recognise, so a
 * plausible-looking invention does not fail loudly - it just never takes
 * effect, which is far harder to diagnose than a parse error.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GAMES, type ModEntry } from '@asp/shared';
import type { Server } from '@prisma/client';
import type { GameAdapter, ParsedLogEvent, QueryResult, ServerSecrets } from '../adapter.js';
import { getSteamCredentials } from '../../platform/steam-credentials.js';
import { decryptSecretToString } from '../../../security/crypto.js';
import { queryA2SInfo } from '../protocols/a2s.js';
import { getGameHost } from '../../network/game-host.js';
import { runRconCommand } from '../protocols/battleye-rcon.js';
import { CONTAINER_DATA_PATH } from '../../docker/container-spec.js';
import { badRequest } from '../../../lib/errors.js';

const game = GAMES.arma3;

/** Arma's 0 = never, 1 = limited, 2 = always triple. */
const visibility = z.number().int().min(0).max(2);
const toggle = z.union([z.literal(0), z.literal(1)]);
const ipv4 = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, 'Must be an IPv4 address');

/**
 * The `Options` block of a difficulty preset.
 *
 * Only read when forcedDifficulty is "Custom". Key names follow the game's own
 * vocabulary exactly - an unrecognised one is dropped by the engine, which
 * looks like the setting simply not working.
 */
const difficultySchema = z
  .object({
    groupIndicators: visibility.default(1),
    friendlyTags: visibility.default(1),
    enemyTags: visibility.default(0),
    detectedMines: visibility.default(0),
    commands: visibility.default(1),
    waypoints: visibility.default(1),
    weaponInfo: visibility.default(2),
    stanceIndicator: visibility.default(2),
    reducedDamage: toggle.default(0),
    staminaBar: toggle.default(1),
    weaponCrosshair: toggle.default(1),
    visionAid: toggle.default(0),
    thirdPersonView: toggle.default(1),
    cameraShake: toggle.default(1),
    scoreTable: toggle.default(1),
    deathMessages: toggle.default(1),
    vonID: toggle.default(1),
    mapContent: toggle.default(1),
    autoReport: toggle.default(1),
    multipleSaves: toggle.default(0),
    aiLevelPreset: z.number().int().min(0).max(3).default(3),
    skillAI: z.number().min(0).max(1).default(0.5),
    precisionAI: z.number().min(0).max(1).default(0.5),
  })
  .default({});

/** Order mirrors the file, so the two are easy to read side by side. */
const DIFFICULTY_OPTION_KEYS = [
  'groupIndicators', 'friendlyTags', 'enemyTags', 'detectedMines', 'commands',
  'waypoints', 'weaponInfo', 'stanceIndicator', 'reducedDamage', 'staminaBar',
  'weaponCrosshair', 'visionAid', 'thirdPersonView', 'cameraShake', 'scoreTable',
  'deathMessages', 'vonID', 'mapContent', 'autoReport', 'multipleSaves',
] as const;

/**
 * `basic.cfg` - the file passed as `-cfg`.
 *
 * Separate from server.cfg and easy to overlook: it holds the bandwidth and
 * packet tuning, and Arma's stock defaults assume a 2013 connection. MinBandwidth
 * at its 131072 default is 128 kbps, which throttles a server that has a
 * gigabit link available. Leaving this file out entirely - which the panel did -
 * means every server ran on those defaults.
 */
const networkSchema = z
  .object({
    /** bps the server is guaranteed. Rough guide: 256 kbit per player. */
    minBandwidth: z.number().int().min(131072).max(1_000_000_000).default(5_120_000),
    /** bps it may never exceed. Lower this when several servers share a link. */
    maxBandwidth: z.number().int().min(131072).max(1_000_000_000).default(10_240_000),
    /** Packets per simulation frame. Higher cuts lag, raises desync. */
    maxMsgSend: z.number().int().min(16).max(8192).default(2048),
    /** Payload of a guaranteed packet, in bytes. */
    maxSizeGuaranteed: z.number().int().min(128).max(2048).default(512),
    /** Payload of a non-guaranteed packet. Guidance is half the guaranteed size. */
    maxSizeNonguaranteed: z.number().int().min(64).max(1024).default(256),
    /** Movement error before a far unit is re-sent. Smaller is smoother, costs traffic. */
    minErrorToSend: z.number().min(0.001).max(1).default(0.01),
    /** The same for near units. Also governs client-to-server traffic. */
    minErrorToSendNear: z.number().min(0.001).max(1).default(0.02),
    /** Custom face and sound uploads, in bytes. 0 blocks them. */
    maxCustomFileSize: z.number().int().min(0).max(10_000_000).default(0),
  })
  .default({});

const configSchema = z.object({
  /* Global */
  hostname: z.string().min(1).max(96),
  password: z.string().max(64).default(''),
  maxPlayers: z.number().int().min(1).max(game.maxSlots),
  logFile: z.string().max(64).default('server_console.log'),
  motd: z.array(z.string().max(120)).max(10).default([]),
  motdInterval: z.number().int().min(0).max(3600).default(5),

  /* Joining rules */
  kickDuplicate: toggle.default(1),
  verifySignatures: z.union([z.literal(0), z.literal(2)]).default(2),
  // 0 = nobody, 1 = headless clients only, 2 = everybody. Defaults closed:
  // file patching lets a client load loose scripts over the mission's own.
  allowedFilePatching: z.number().int().min(0).max(2).default(0),
  requiredBuild: z.number().int().min(0).max(999_999).nullable().default(null),
  loopback: toggle.default(0),

  /* Whitelists */
  admins: z
    .array(z.string().regex(/^\d{5,20}$/, 'Admin entries must be Steam64 IDs'))
    .max(64)
    .default([]),
  headlessClients: z.array(ipv4).max(16).default([]),
  localClient: z.array(ipv4).max(16).default([]),

  /* Voting */
  voteMissionPlayers: z.number().int().min(1).max(256).default(1),
  voteThreshold: z.number().min(0).max(2).default(0.33),

  /* In-game */
  forceRotorLibSimulation: z.number().int().min(0).max(2).default(0),
  disableVoN: toggle.default(0),
  vonCodec: toggle.default(1),
  vonCodecQuality: z.number().int().min(0).max(30).default(10),
  persistent: toggle.default(1),
  timeStampFormat: z.enum(['none', 'short', 'full']).default('short'),
  battleEye: toggle.default(1),
  drawingInMap: toggle.default(1),
  disconnectTimeout: z.number().int().min(5).max(90).default(90),
  maxDesync: z.number().int().min(0).max(1000).default(150),
  maxPing: z.number().int().min(0).max(1000).default(200),
  maxPacketLoss: z.number().int().min(0).max(100).default(50),
  forcedDifficulty: z.enum(['Recruit', 'Regular', 'Veteran', 'Custom']).default('Custom'),
  difficulty: difficultySchema,

  /* Network tuning - written to basic.cfg, passed as -cfg */
  network: networkSchema,

  missions: z
    .array(
      z.object({
        template: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.\-]+$/, 'Invalid mission template'),
        difficulty: z.enum(['recruit', 'regular', 'veteran', 'custom']).default('regular'),
      }),
    )
    .max(32)
    .default([]),
});

export type Arma3Config = z.infer<typeof configSchema>;

/**
 * Extensions the mission may load at runtime.
 *
 * Fixed, not configurable. `loadFile`/`preprocessFile` with an open extension
 * list is a file-read primitive inside the server process, so exposing it
 * through the config API would turn "edit your server settings" into "read
 * arbitrary files from the game container". These are the values Bohemia ship.
 */
const ALLOWED_LOAD_EXTENSIONS = [
  'hpp', 'sqs', 'sqf', 'fsm', 'cpp', 'paa', 'txt', 'xml', 'inc', 'ext',
  'sqm', 'ods', 'fxy', 'lip', 'csv', 'kb', 'bik', 'bikb', 'html', 'htm', 'biedi',
];
const ALLOWED_HTML_EXTENSIONS = ['htm', 'html', 'xml', 'txt'];

/**
 * Escapes a value for Arma's config syntax.
 *
 * Backslashes first, then quotes; control characters removed entirely. Without
 * this, `hostname = "x"; adminPassword = "y"` in a server name would become
 * two directives. Nothing else is escaped - a URL in a server name must survive
 * intact, slashes and all.
 */
function cfgString(value: string): string {
  const escaped = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '""');
  return `"${escaped}"`;
}

function cfgArray(values: readonly string[]): string {
  return `{${values.map(cfgString).join(', ')}}`;
}

/**
 * Renders `server.cfg`.
 *
 * Separated from the write so it can be tested without a database, a volume or
 * an encryption key - the shape of this file is the difference between a server
 * that boots and one that exits while parsing its config.
 */
export function renderServerCfg(
  config: Arma3Config,
  secrets: Pick<ServerSecrets, 'adminPassword' | 'rconPassword'>,
): string {
  const options = config.difficulty;

  const lines: string[] = [
    '//',
    '// Generated by Arma Server Panel. Manual edits are overwritten on start.',
    '// Change these from the panel instead: Server -> Settings.',
    '//',
    '',
    '// GLOBAL SETTINGS',
    `hostname = ${cfgString(config.hostname)};`,
    `password = ${cfgString(config.password)};`,
    `passwordAdmin = ${cfgString(secrets.adminPassword)};`,
    `serverCommandPassword = ${cfgString(secrets.rconPassword)};`,
    '',
    `logFile = ${cfgString(config.logFile)};`,
    '',
    `motd[] = ${cfgArray(config.motd)};`,
    `motdInterval = ${config.motdInterval};`,
    '',
    '// JOINING RULES',
    `maxPlayers = ${config.maxPlayers};`,
    `kickDuplicate = ${config.kickDuplicate};`,
    `verifySignatures = ${config.verifySignatures};`,
    `allowedFilePatching = ${config.allowedFilePatching};`,
    ...(config.requiredBuild === null ? [] : [`requiredBuild = ${config.requiredBuild};`]),
    '',
    `loopback = ${config.loopback};`,
    '// Always off. The panel opens ports itself and records what it opened;',
    '// letting the game do it too leaves duplicate router mappings behind that',
    '// nothing ever cleans up.',
    'upnp = 0;',
    '',
    '// WHITELISTS',
    `admins[] = ${cfgArray(config.admins)};`,
    `headlessClients[] = ${cfgArray(config.headlessClients)};`,
    `localClient[] = ${cfgArray(config.localClient)};`,
    '',
    '// VOTING',
    `voteMissionPlayers = ${config.voteMissionPlayers};`,
    `voteThreshold = ${config.voteThreshold};`,
    '',
    '// INGAME SETTINGS',
    `forceRotorLibSimulation = ${config.forceRotorLibSimulation};`,
    `disableVoN = ${config.disableVoN};`,
    `vonCodec = ${config.vonCodec};`,
    `vonCodecQuality = ${config.vonCodecQuality};`,
    `persistent = ${config.persistent};`,
    `timeStampFormat = ${cfgString(config.timeStampFormat)};`,
    `BattlEye = ${config.battleEye};`,
    `drawingInMap = ${config.drawingInMap};`,
    `allowedLoadFileExtensions[] = ${cfgArray(ALLOWED_LOAD_EXTENSIONS)};`,
    `allowedPreprocessFileExtensions[] = ${cfgArray(ALLOWED_LOAD_EXTENSIONS)};`,
    `allowedHTMLLoadExtensions[] = ${cfgArray(ALLOWED_HTML_EXTENSIONS)};`,
    `disconnectTimeout = ${config.disconnectTimeout};`,
    `maxdesync = ${config.maxDesync};`,
    `maxping = ${config.maxPing};`,
    `maxpacketloss = ${config.maxPacketLoss};`,
    `forcedDifficulty = ${cfgString(config.forcedDifficulty)};`,
    '',
    '// SCRIPTING ISSUES',
    // Left empty deliberately. These are SQF the server executes on connect;
    // accepting them through the config API would be remote code execution
    // inside the game server, dressed up as a setting.
    'onUserConnected = "";',
    'onUserDisconnected = "";',
    'doubleIdDetected = "";',
    '',
    '// SIGNATURE VERIFICATION',
    'onUnsignedData = "kick (_this select 0)";',
    'onHackedData = "kick (_this select 0)";',
    'onDifferentData = "";',
    '',
    '// MISSIONS CYCLE',
    'class Missions',
    '{',
  ];

  config.missions.forEach((mission, index) => {
    lines.push(
      `    class Mission_${index}`,
      '    {',
      `        template = ${cfgString(mission.template)};`,
      `        difficulty = ${cfgString(mission.difficulty)};`,
      '    };',
    );
  });

  lines.push(
    '};',
    '',
    '// DIFFICULTY',
    'class DifficultyPresets',
    '{',
    '    class CustomDifficulty',
    '    {',
    '        class Options',
    '        {',
    ...DIFFICULTY_OPTION_KEYS.map((key) => `            ${key} = ${options[key]};`),
    '        };',
    `        aiLevelPreset = ${options.aiLevelPreset};`,
    '    };',
    '    class CustomAILevel',
    '    {',
    `        skillAI = ${options.skillAI};`,
    `        precisionAI = ${options.precisionAI};`,
    '    };',
    '};',
    '',
  );

  return lines.join('\n');
}

/**
 * Renders `basic.cfg`.
 *
 * Plain `key=value;` pairs - not the class syntax of server.cfg - so no string
 * escaping is involved. Every value here is a number validated by the schema.
 */
export function renderBasicCfg(config: Arma3Config): string {
  const net = config.network;
  return [
    '//',
    '// Generated by Arma Server Panel. Manual edits are overwritten on start.',
    '// Network tuning, passed to the server as -cfg.',
    '//',
    '',
    '// BANDWIDTH',
    `MinBandwidth=${net.minBandwidth};`,
    `MaxBandwidth=${net.maxBandwidth};`,
    '',
    '// PACKETS',
    `MaxMsgSend=${net.maxMsgSend};`,
    `MaxSizeGuaranteed=${net.maxSizeGuaranteed};`,
    `MaxSizeNonguaranteed=${net.maxSizeNonguaranteed};`,
    '',
    '// SMOOTHNESS',
    `MinErrorToSend=${net.minErrorToSend};`,
    `MinErrorToSendNear=${net.minErrorToSendNear};`,
    '',
    '// MISC',
    `MaxCustomFileSize=${net.maxCustomFileSize};`,
    '',
  ].join('\n');
}

export const arma3Adapter: GameAdapter = {
  id: 'arma3',

  defaultConfig({ name, slots }) {
    return configSchema.parse({
      hostname: name,
      maxPlayers: Math.min(slots, game.maxSlots),
      motd: ['Powered by Arma Server Panel'],
      missions: [],
      admins: [],
    });
  },

  validateConfig(patch, current) {
    const merged = { ...current, ...(patch as Record<string, unknown>) };
    const result = configSchema.safeParse(merged);
    if (!result.success) {
      throw badRequest(
        'Server configuration is not valid.',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  },

  async buildEnv(server) {
    const steam = await getSteamCredentials();
    return {
      ASP_SERVER_ID: server.id,
      ASP_GAME: 'arma3',
      ASP_SLOTS: String(server.slots),
      ASP_BASE_PORT: String(server.basePort),
      // Arma derives the Steam query and master ports from -port as +1 and +2.
      // They are not settable in server.cfg, which is why every server is given
      // a wide port block rather than a tightly packed one.
      ASP_GAME_PORT: String(server.basePort),
      ASP_QUERY_PORT: String(server.basePort + 1),
      ASP_BATTLEYE_PORT: String(server.basePort + 4),
      ASP_CONFIG_FILE: `${CONTAINER_DATA_PATH}/config/server.cfg`,
      ASP_MODS_FILE: `${CONTAINER_DATA_PATH}/config/mods.txt`,
      STEAM_APP_ID: String(game.steamAppId),
      STEAM_GAME_APP_ID: String(game.steamGameAppId),
      // Only set when configured; an empty value would make SteamCMD attempt
      // an anonymous login, which cannot fetch a paid title and fails with a
      // far less obvious error than "credentials missing".
      ...(steam ? { STEAM_USERNAME: steam.username, STEAM_PASSWORD: steam.password } : {}),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };
  },

  async writeConfig(server) {
    const config = configSchema.parse(server.config);
    const secrets = readSecrets(server);

    const configDir = path.join(server.volumePath, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o750 });
    await writeFile(path.join(configDir, 'server.cfg'), renderServerCfg(config, secrets), {
      mode: 0o640,
    });
    await writeFile(path.join(configDir, 'basic.cfg'), renderBasicCfg(config), { mode: 0o640 });

    // BattlEye RCON config lives beside it and carries its own password.
    const beDir = path.join(server.volumePath, 'battleye');
    await mkdir(beDir, { recursive: true, mode: 0o750 });
    await writeFile(
      path.join(beDir, 'beserver_x64.cfg'),
      [
        `RConPassword ${secrets.battleyeRconPassword}`,
        `RConPort ${server.basePort + 4}`,
        // Bound to the container's own interface only; never published.
        'RConIP 0.0.0.0',
        'RestrictRCon 0',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  },

  async writeMods(server, mods: ModEntry[]) {
    const enabled = mods
      .filter((m) => m.enabled)
      .sort((a, b) => a.order - b.order)
      // Mod ids are validated as alphanumeric upstream; re-check here because
      // this string ends up on the game's command line.
      .filter((m) => /^\d+$/.test(m.modId));

    const configDir = path.join(server.volumePath, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o750 });

    await writeFile(
      path.join(configDir, 'mods.txt'),
      enabled.map((m) => `@${m.modId}`).join(';') + '\n',
      { mode: 0o640 },
    );

    await writeFile(
      path.join(configDir, 'mods.json'),
      JSON.stringify(
        enabled.map((m) => ({ id: m.modId, name: m.name, version: m.version })),
        null,
        2,
      ),
      { mode: 0o640 },
    );
  },

  async query(server): Promise<QueryResult> {
    // Steam query port is game port + 1.
    const info = await queryA2SInfo(await getGameHost(), server.basePort + 1);
    if (!info) {
      return {
        online: false,
        playersOnline: 0,
        maxPlayers: server.slots,
        serverName: null,
        map: null,
        version: null,
        ping: null,
      };
    }
    return {
      online: true,
      playersOnline: info.players,
      maxPlayers: info.maxPlayers,
      serverName: info.name,
      map: info.map,
      version: info.version,
      ping: info.ping,
    };
  },

  parseLogLine(line): ParsedLogEvent {
    const connected = /Player ([^:]+) connected/i.exec(line);
    if (connected) {
      return { kind: 'player_join', message: line, playerName: connected[1]?.trim() };
    }
    const disconnected = /Player ([^:]+) disconnected/i.exec(line);
    if (disconnected) {
      return { kind: 'player_leave', message: line, playerName: disconnected[1]?.trim() };
    }
    if (/Host identity created|Game started/i.test(line)) {
      return { kind: 'ready', message: line };
    }
    if (/Shutdown normally|Host destroyed/i.test(line)) {
      return { kind: 'shutdown', message: line };
    }
    if (/ErrorMessage|Error:|Fatal|Cannot load/i.test(line)) {
      return { kind: 'error', message: line };
    }
    return { kind: 'other', message: line };
  },

  async sendRconCommand(server, command) {
    const secrets = readSecrets(server);
    return runRconCommand(
      {
        host: await getGameHost(),
        port: server.basePort + 4,
        password: secrets.battleyeRconPassword,
      },
      command,
    );
  },
};

function readSecrets(server: Server): ServerSecrets {
  if (!server.secretsEnc) {
    throw new Error(`Server ${server.id} has no secrets envelope`);
  }
  return JSON.parse(decryptSecretToString(server.secretsEnc, 'server-secrets')) as ServerSecrets;
}

export { readSecrets };
