/**
 * Arma Reforger dedicated server adapter.
 *
 * Reforger takes a single JSON config, which makes generation safer than
 * Arma 3's text format - there is no escaping to get wrong, only schema
 * validation. Mods are declared inline in that JSON as {modId, name, version}.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GAMES, type ModEntry } from '@asp/shared';
import type { GameAdapter, ParsedLogEvent, QueryResult } from '../adapter.js';
import { queryA2SInfo } from '../protocols/a2s.js';
import { getGameHost } from '../../network/game-host.js';
import { runRconCommand } from '../protocols/battleye-rcon.js';
import { CONTAINER_DATA_PATH } from '../../docker/container-spec.js';
import { badRequest } from '../../../lib/errors.js';
import { readSecrets } from './arma3.js';

const game = GAMES.reforger;

/** Reforger workshop ids are 16-character uppercase hex. */
const workshopIdSchema = z
  .string()
  .regex(/^[0-9A-F]{16}$/, 'Reforger mod ids are 16 uppercase hex characters');

const configSchema = z.object({
  serverName: z.string().min(1).max(100),
  serverPassword: z.string().max(64).default(''),
  // No adminPassword here on purpose. writeConfig takes `passwordAdmin` from
  // the server's encrypted secrets envelope, so a value in the config was only
  // ever decorative - an operator could set one, save, and have it do nothing.
  maxPlayers: z.number().int().min(1).max(game.maxSlots),
  visible: z.boolean().default(true),
  crossPlatform: z.boolean().default(true),
  supportedPlatforms: z
    .array(z.enum(['PLATFORM_PC', 'PLATFORM_XBL', 'PLATFORM_PSN']))
    .min(1)
    .default(['PLATFORM_PC', 'PLATFORM_XBL']),
  battlEye: z.boolean().default(true),
  disableThirdPerson: z.boolean().default(false),
  fastValidation: z.boolean().default(true),
  serverMaxViewDistance: z.number().int().min(500).max(10000).default(2500),
  serverMinGrassDistance: z.number().int().min(0).max(150).default(50),
  networkViewDistance: z.number().int().min(500).max(5000).default(1500),
  aiLimit: z.number().int().min(-1).max(1000).default(-1),
  playerSaveTime: z.number().int().min(30).max(3600).default(120),
  autoReload: z.number().int().min(0).max(3600).default(0),
  scenarioId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\{[0-9A-F]{16}\}[A-Za-z0-9_\-./]+$/, 'Invalid scenario id')
    .default('{ECC61978EDCC2B5A}Missions/23_Campaign.conf'),
  admins: z.array(z.string().max(64)).max(64).default([]),
  rconEnabled: z.boolean().default(true),
  rconPermission: z.enum(['admin', 'monitor']).default('admin'),
  a2sEnabled: z.boolean().default(true),
  missionHeader: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type ReforgerConfig = z.infer<typeof configSchema>;

export const reforgerAdapter: GameAdapter = {
  id: 'reforger',

  defaultConfig({ name, slots }) {
    return configSchema.parse({
      serverName: name,
      maxPlayers: Math.min(slots, game.maxSlots),
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
    return {
      ASP_SERVER_ID: server.id,
      ASP_GAME: 'reforger',
      ASP_SLOTS: String(server.slots),
      ASP_BASE_PORT: String(server.basePort),
      ASP_GAME_PORT: String(server.basePort),
      ASP_QUERY_PORT: String(server.basePort + 1),
      ASP_RCON_PORT: String(server.basePort + 2),
      ASP_BATTLEYE_PORT: String(server.basePort + 3),
      ASP_CONFIG_FILE: `${CONTAINER_DATA_PATH}/config/config.json`,
      ASP_PUBLIC_HOST: server.publicHost,
      STEAM_APP_ID: String(game.steamAppId),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };
  },

  async writeConfig(server) {
    const config = configSchema.parse(server.config);
    const secrets = readSecrets(server);

    const mods = await loadMods(server.id);

    const payload = {
      bindAddress: '0.0.0.0',
      bindPort: server.basePort,
      publicAddress: server.publicHost,
      publicPort: server.publicBasePort,
      a2s: {
        address: '0.0.0.0',
        port: server.basePort + 1,
      },
      rcon: config.rconEnabled
        ? {
            address: '0.0.0.0',
            port: server.basePort + 2,
            password: secrets.rconPassword,
            permission: config.rconPermission,
            blacklist: [] as string[],
            whitelist: [] as string[],
            maxClients: 4,
          }
        : undefined,
      game: {
        name: config.serverName,
        password: config.serverPassword,
        passwordAdmin: secrets.adminPassword,
        admins: config.admins,
        scenarioId: config.scenarioId,
        maxPlayers: config.maxPlayers,
        visible: config.visible,
        crossPlatform: config.crossPlatform,
        supportedPlatforms: config.supportedPlatforms,
        gameProperties: {
          serverMaxViewDistance: config.serverMaxViewDistance,
          serverMinGrassDistance: config.serverMinGrassDistance,
          networkViewDistance: config.networkViewDistance,
          disableThirdPerson: config.disableThirdPerson,
          fastValidation: config.fastValidation,
          battlEye: config.battlEye,
          missionHeader: config.missionHeader,
        },
        mods: mods
          .filter((m) => m.enabled)
          .sort((a, b) => a.order - b.order)
          .map((m) => ({
            modId: m.modId,
            name: m.name,
            ...(m.version ? { version: m.version } : {}),
            required: m.required,
          })),
      },
      operating: {
        lobbyPlayerSynchronise: true,
        playerSaveTime: config.playerSaveTime,
        aiLimit: config.aiLimit,
        disableCrashReporter: true,
        disableNavmeshStreaming: [] as string[],
        ...(config.autoReload > 0 ? { autoReload: config.autoReload } : {}),
      },
    };

    const configDir = path.join(server.volumePath, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o750 });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify(payload, null, 2), {
      mode: 0o640,
    });
  },

  async writeMods(server, mods: ModEntry[]) {
    // Reforger reads mods from the main config, so writing them means
    // regenerating it. Validate ids first.
    for (const mod of mods) {
      const parsed = workshopIdSchema.safeParse(mod.modId);
      if (!parsed.success) {
        throw badRequest(`"${mod.name}" has an invalid Reforger mod id.`);
      }
    }
    await reforgerAdapter.writeConfig(server);
  },

  async query(server): Promise<QueryResult> {
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
    const joined = /Player connected.*name=([^,]+)/i.exec(line);
    if (joined) return { kind: 'player_join', message: line, playerName: joined[1]?.trim() };

    const left = /Player disconnected.*name=([^,]+)/i.exec(line);
    if (left) return { kind: 'player_leave', message: line, playerName: left[1]?.trim() };

    const fps = /FPS:\s*([\d.]+)/i.exec(line);
    if (fps) return { kind: 'fps', message: line, fps: Number(fps[1]) };

    if (/Game successfully created|Server is now listening/i.test(line)) {
      return { kind: 'ready', message: line };
    }
    if (/Shutting down|Server shutdown/i.test(line)) {
      return { kind: 'shutdown', message: line };
    }
    if (/\bERROR\b|\bFATAL\b|Unable to|Failed to/i.test(line)) {
      return { kind: 'error', message: line };
    }
    return { kind: 'other', message: line };
  },

  async sendRconCommand(server, command) {
    const secrets = readSecrets(server);
    return runRconCommand(
      { host: await getGameHost(), port: server.basePort + 2, password: secrets.rconPassword },
      command,
    );
  },
};

async function loadMods(serverId: string): Promise<ModEntry[]> {
  const { prisma } = await import('../../../db/client.js');
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
