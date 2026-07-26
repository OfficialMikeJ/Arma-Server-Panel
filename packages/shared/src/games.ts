/**
 * Supported game titles.
 *
 * Adding a title requires: an entry here, a Dockerfile under docker/<id>/,
 * and an adapter under apps/api/src/modules/games/adapters/.
 */

export const GAME_IDS = ['arma3', 'reforger', 'arma4'] as const;
export type GameId = (typeof GAME_IDS)[number];

export type ConfigFormat = 'arma-cpp' | 'json';
export type ModSource = 'steam-workshop' | 'reforger-workshop' | 'none';

export interface PortSpec {
  /** Stable key used by the port allocator and the container port map. */
  key: string;
  label: string;
  protocol: 'udp' | 'tcp';
  /** Offset from the server's allocated base port. */
  offset: number;
  /** Whether the port must be published to the public internet. */
  public: boolean;
  optional?: boolean;
}

export interface GameDefinition {
  id: GameId;
  name: string;
  shortName: string;
  /** false until the title ships; the UI shows it as "Coming soon". */
  released: boolean;
  /** Steam application id of the dedicated server package. */
  steamAppId: number | null;
  /** Steam app id of the base game, used for Workshop lookups. */
  steamGameAppId: number | null;
  /** Steam login required to download the server files. */
  requiresSteamLogin: boolean;
  /** Container image tag built from docker/<id>/Dockerfile. */
  image: string;
  /** Recommended and hard-floor memory, in MiB. */
  memoryMib: { min: number; recommended: number };
  cpu: { min: number; recommended: number };
  storageGib: { min: number; recommended: number };
  ports: PortSpec[];
  configFormat: ConfigFormat;
  configFileName: string;
  modSource: ModSource;
  /** Supports the BattlEye RCON UDP protocol. */
  battleyeRcon: boolean;
  /** Supports A2S (Source engine) queries. */
  a2sQuery: boolean;
  /** Native save-game persistence toggle. */
  persistence: boolean;
  defaultSlots: number;
  maxSlots: number;
  /** Startup flags an operator is allowed to override. Everything else is fixed. */
  editableStartupParams: string[];
}

export const GAMES: Readonly<Record<GameId, GameDefinition>> = Object.freeze({
  arma3: {
    id: 'arma3',
    name: 'Arma 3',
    shortName: 'Arma 3',
    released: true,
    steamAppId: 233780,
    steamGameAppId: 107410,
    requiresSteamLogin: true,
    image: 'asp/arma3:latest',
    memoryMib: { min: 8 * 1024, recommended: 16 * 1024 },
    cpu: { min: 2, recommended: 6 },
    storageGib: { min: 40, recommended: 80 },
    ports: [
      { key: 'game', label: 'Game', protocol: 'udp', offset: 0, public: true },
      { key: 'steamQuery', label: 'Steam Query', protocol: 'udp', offset: 1, public: true },
      { key: 'steamMaster', label: 'Steam Master', protocol: 'udp', offset: 2, public: true },
      { key: 'von', label: 'VoN', protocol: 'udp', offset: 3, public: true },
      { key: 'battleye', label: 'BattlEye RCON', protocol: 'udp', offset: 4, public: false, optional: true },
    ],
    configFormat: 'arma-cpp',
    configFileName: 'server.cfg',
    modSource: 'steam-workshop',
    battleyeRcon: true,
    a2sQuery: true,
    persistence: true,
    defaultSlots: 32,
    maxSlots: 128,
    editableStartupParams: [
      'world', 'autoInit', 'loadMissionToMemory', 'filePatching', 'netlog',
      'enableHT', 'hugepages', 'limitFPS', 'maxMem', 'cpuCount', 'malloc',
    ],
  },

  reforger: {
    id: 'reforger',
    name: 'Arma Reforger',
    shortName: 'Reforger',
    released: true,
    steamAppId: 1874900,
    steamGameAppId: 1874880,
    requiresSteamLogin: false,
    image: 'asp/reforger:latest',
    memoryMib: { min: 8 * 1024, recommended: 16 * 1024 },
    cpu: { min: 4, recommended: 6 },
    storageGib: { min: 30, recommended: 60 },
    ports: [
      { key: 'game', label: 'Game', protocol: 'udp', offset: 0, public: true },
      { key: 'a2s', label: 'A2S Query', protocol: 'udp', offset: 1, public: true, optional: true },
      { key: 'rcon', label: 'Reforger RCON', protocol: 'udp', offset: 2, public: false, optional: true },
      { key: 'battleye', label: 'BattlEye RCON', protocol: 'udp', offset: 3, public: false, optional: true },
    ],
    configFormat: 'json',
    configFileName: 'config.json',
    modSource: 'reforger-workshop',
    battleyeRcon: true,
    a2sQuery: true,
    persistence: true,
    defaultSlots: 64,
    maxSlots: 128,
    editableStartupParams: [
      'maxFPS', 'loadSessionSave', 'autoReload', 'logStats', 'logLevel',
      'nds', 'nwkResolution', 'staggeringBudget', 'streamingBudget', 'streamsDelta',
    ],
  },

  arma4: {
    id: 'arma4',
    name: 'Arma 4',
    shortName: 'Arma 4',
    released: false,
    steamAppId: null,
    steamGameAppId: null,
    requiresSteamLogin: false,
    image: 'asp/arma4:latest',
    memoryMib: { min: 8 * 1024, recommended: 32 * 1024 },
    cpu: { min: 4, recommended: 8 },
    storageGib: { min: 60, recommended: 120 },
    ports: [
      { key: 'game', label: 'Game', protocol: 'udp', offset: 0, public: true },
      { key: 'a2s', label: 'A2S Query', protocol: 'udp', offset: 1, public: true, optional: true },
      { key: 'rcon', label: 'RCON', protocol: 'udp', offset: 2, public: false, optional: true },
    ],
    configFormat: 'json',
    configFileName: 'config.json',
    modSource: 'none',
    battleyeRcon: true,
    a2sQuery: true,
    persistence: true,
    defaultSlots: 64,
    maxSlots: 256,
    editableStartupParams: ['maxFPS', 'logLevel'],
  },
});

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);
}

export function getGame(id: GameId): GameDefinition {
  return GAMES[id];
}

/** Titles that can actually be provisioned right now. */
export function releasedGames(): GameDefinition[] {
  return GAME_IDS.map((id) => GAMES[id]).filter((g) => g.released);
}
