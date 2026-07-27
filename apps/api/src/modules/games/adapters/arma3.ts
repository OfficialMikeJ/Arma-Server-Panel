/**
 * Arma 3 dedicated server adapter.
 *
 * Config is Arma's own `.cfg` format, which is a C-like key/value syntax. It
 * is generated from a validated object - never by concatenating user strings -
 * and every string value is escaped, because a server name containing a quote
 * or newline would otherwise let a user inject arbitrary config directives.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GAMES, type ModEntry } from '@asp/shared';
import type { Server } from '@prisma/client';
import type { GameAdapter, ParsedLogEvent, QueryResult, ServerSecrets } from '../adapter.js';
import { loadConfig } from '../../../config/env.js';
import { decryptSecretToString } from '../../../security/crypto.js';
import { queryA2SInfo } from '../protocols/a2s.js';
import { getGameHost } from '../../network/game-host.js';
import { runRconCommand } from '../protocols/battleye-rcon.js';
import { CONTAINER_DATA_PATH } from '../../docker/container-spec.js';
import { badRequest } from '../../../lib/errors.js';

const game = GAMES.arma3;

const configSchema = z.object({
  hostname: z.string().min(1).max(96),
  password: z.string().max(64).default(''),
  maxPlayers: z.number().int().min(1).max(game.maxSlots),
  motd: z.array(z.string().max(120)).max(10).default([]),
  motdInterval: z.number().int().min(0).max(3600).default(5),
  verifySignatures: z.union([z.literal(0), z.literal(2)]).default(2),
  requiredSecureId: z.number().int().min(0).max(2).default(2),
  battleEye: z.union([z.literal(0), z.literal(1)]).default(1),
  persistent: z.union([z.literal(0), z.literal(1)]).default(1),
  disableVoN: z.union([z.literal(0), z.literal(1)]).default(0),
  vonCodecQuality: z.number().int().min(0).max(30).default(10),
  timeStampFormat: z.enum(['none', 'short', 'full']).default('short'),
  logFile: z.string().max(64).default('server_console.log'),
  votingThreshold: z.number().min(0).max(2).default(0.33),
  voteMissionPlayers: z.number().int().min(1).max(256).default(1),
  kickDuplicate: z.union([z.literal(0), z.literal(1)]).default(1),
  allowedFilePatching: z.number().int().min(0).max(2).default(1),
  missions: z
    .array(
      z.object({
        template: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.\-]+$/, 'Invalid mission template'),
        difficulty: z.enum(['recruit', 'regular', 'veteran', 'custom']).default('regular'),
      }),
    )
    .max(32)
    .default([]),
  admins: z
    .array(z.string().regex(/^\d{5,20}$/, 'Admin entries must be Steam64 IDs'))
    .max(64)
    .default([]),
});

export type Arma3Config = z.infer<typeof configSchema>;

/**
 * Escapes a value for Arma's config syntax.
 *
 * Backslashes first, then quotes; control characters removed entirely. Without
 * this, `hostname = "x"; adminPassword = "y"` in a server name would become
 * two directives.
 */
function cfgString(value: string): string {
  const escaped = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '""');
  return `"${escaped}"`;
}

function cfgArray(values: string[]): string {
  return `{${values.map(cfgString).join(', ')}}`;
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

  buildEnv(server) {
    const config = loadConfig();
    return {
      ASP_SERVER_ID: server.id,
      ASP_GAME: 'arma3',
      ASP_SLOTS: String(server.slots),
      ASP_BASE_PORT: String(server.basePort),
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
      ...(config.STEAM_USERNAME ? { STEAM_USERNAME: config.STEAM_USERNAME } : {}),
      ...(config.STEAM_PASSWORD ? { STEAM_PASSWORD: config.STEAM_PASSWORD } : {}),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };
  },

  async writeConfig(server) {
    const config = configSchema.parse(server.config);
    const secrets = readSecrets(server);

    const lines: string[] = [
      '// Generated by Arma Server Panel. Manual edits are overwritten on start.',
      `hostname = ${cfgString(config.hostname)};`,
      `password = ${cfgString(config.password)};`,
      `passwordAdmin = ${cfgString(secrets.adminPassword)};`,
      `serverCommandPassword = ${cfgString(secrets.rconPassword)};`,
      `maxPlayers = ${config.maxPlayers};`,
      // Pin the Steam ports rather than relying on Arma deriving them from
      // -port. Left unset they fall back to the stock 2303/2304, which means
      // the first server on the host wins them and every other one silently
      // fails to register with Steam and to answer A2S queries - so the panel
      // reports the server as offline with zero players even while it runs.
      `steamQueryPort = ${server.basePort + 1};`,
      `steamPort = ${server.basePort + 2};`,
      `motd[] = ${cfgArray(config.motd)};`,
      `motdInterval = ${config.motdInterval};`,
      `verifySignatures = ${config.verifySignatures};`,
      `requiredSecureId = ${config.requiredSecureId};`,
      `BattlEye = ${config.battleEye};`,
      `persistent = ${config.persistent};`,
      `disableVoN = ${config.disableVoN};`,
      `vonCodecQuality = ${config.vonCodecQuality};`,
      `timeStampFormat = ${cfgString(config.timeStampFormat)};`,
      `logFile = ${cfgString(config.logFile)};`,
      `voteThreshold = ${config.votingThreshold};`,
      `voteMissionPlayers = ${config.voteMissionPlayers};`,
      `kickDuplicate = ${config.kickDuplicate};`,
      `allowedFilePatching = ${config.allowedFilePatching};`,
      `admins[] = ${cfgArray(config.admins)};`,
      '',
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

    lines.push('};', '');

    const configDir = path.join(server.volumePath, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o750 });
    await writeFile(path.join(configDir, 'server.cfg'), lines.join('\n'), { mode: 0o640 });

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
