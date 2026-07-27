/**
 * Arma 4 adapter.
 *
 * Arma 4 has not shipped, so its server config format is not yet known. This
 * adapter is deliberately conservative: it models the title on Reforger's
 * Enfusion-based JSON config (the most likely shape), refuses to provision
 * while `released` is false, and keeps every title-specific assumption in this
 * one file so switching to the real format is a single-file change.
 *
 * The rest of the platform - orchestration, resources, networking, console,
 * mods, AI - needs no change when Arma 4 lands.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GAMES } from '@asp/shared';
import type { GameAdapter, ParsedLogEvent, QueryResult } from '../adapter.js';
import { queryA2SInfo } from '../protocols/a2s.js';
import { getGameHost } from '../../network/game-host.js';
import { runRconCommand } from '../protocols/battleye-rcon.js';
import { CONTAINER_DATA_PATH } from '../../docker/container-spec.js';
import { badRequest, preconditionFailed } from '../../../lib/errors.js';
import { readSecrets } from './arma3.js';

const game = GAMES.arma4;

const configSchema = z.object({
  serverName: z.string().min(1).max(100),
  serverPassword: z.string().max(64).default(''),
  maxPlayers: z.number().int().min(1).max(game.maxSlots),
  visible: z.boolean().default(true),
  battlEye: z.boolean().default(true),
  crossPlatform: z.boolean().default(true),
  scenarioId: z.string().max(256).default(''),
  admins: z.array(z.string().max(64)).max(64).default([]),
  rconEnabled: z.boolean().default(true),
  playerSaveTime: z.number().int().min(30).max(3600).default(120),
});

function assertReleased(): void {
  if (!game.released) {
    throw preconditionFailed(
      'Arma 4 has not been released yet. The panel will support it on launch day - no update to your servers required.',
      'game_unavailable',
    );
  }
}

export const arma4Adapter: GameAdapter = {
  id: 'arma4',

  defaultConfig({ name, slots }) {
    return configSchema.parse({
      serverName: name,
      maxPlayers: Math.min(slots, game.maxSlots),
    });
  },

  validateConfig(patch, current) {
    const result = configSchema.safeParse({ ...current, ...(patch as Record<string, unknown>) });
    if (!result.success) {
      throw badRequest(
        'Server configuration is not valid.',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  },

  async buildEnv(server) {
    return {
      ASP_SERVER_ID: server.id,
      ASP_GAME: 'arma4',
      ASP_SLOTS: String(server.slots),
      ASP_BASE_PORT: String(server.basePort),
      ASP_GAME_PORT: String(server.basePort),
      ASP_QUERY_PORT: String(server.basePort + 1),
      ASP_RCON_PORT: String(server.basePort + 2),
      ASP_CONFIG_FILE: `${CONTAINER_DATA_PATH}/config/config.json`,
      ASP_PUBLIC_HOST: server.publicHost,
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };
  },

  async writeConfig(server) {
    assertReleased();
    const config = configSchema.parse(server.config);
    const secrets = readSecrets(server);

    const payload = {
      bindAddress: '0.0.0.0',
      bindPort: server.basePort,
      publicAddress: server.publicHost,
      publicPort: server.publicBasePort,
      a2s: { address: '0.0.0.0', port: server.basePort + 1 },
      rcon: config.rconEnabled
        ? { address: '0.0.0.0', port: server.basePort + 2, password: secrets.rconPassword }
        : undefined,
      game: {
        name: config.serverName,
        password: config.serverPassword,
        passwordAdmin: secrets.adminPassword,
        maxPlayers: config.maxPlayers,
        visible: config.visible,
        crossPlatform: config.crossPlatform,
        scenarioId: config.scenarioId,
        admins: config.admins,
        gameProperties: { battlEye: config.battlEye },
      },
      operating: { playerSaveTime: config.playerSaveTime },
    };

    const configDir = path.join(server.volumePath, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o750 });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify(payload, null, 2), {
      mode: 0o640,
    });
  },

  async writeMods(server) {
    assertReleased();
    await arma4Adapter.writeConfig(server);
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
    if (/\bERROR\b|\bFATAL\b/i.test(line)) return { kind: 'error', message: line };
    if (/Server is now listening|Game successfully created/i.test(line)) {
      return { kind: 'ready', message: line };
    }
    if (/Shutting down/i.test(line)) return { kind: 'shutdown', message: line };
    return { kind: 'other', message: line };
  },

  async sendRconCommand(server, command) {
    assertReleased();
    const secrets = readSecrets(server);
    return runRconCommand(
      { host: await getGameHost(), port: server.basePort + 2, password: secrets.rconPassword },
      command,
    );
  },
};
