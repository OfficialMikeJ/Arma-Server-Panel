import type { GameId } from './games.js';

export type ServerState =
  | 'creating'
  | 'installing'
  | 'offline'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'restarting'
  | 'reinstalling'
  | 'crashed'
  | 'suspended'
  | 'deleting';

/** States from which a power action may be issued. */
export const POWER_ACTIONABLE_STATES: readonly ServerState[] = [
  'offline',
  'running',
  'crashed',
];

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill' | 'reinstall';

export type UserRole = 'owner' | 'admin' | 'operator' | 'viewer';

/** Fine-grained permissions attached to a server membership or an API key. */
export const PERMISSIONS = [
  'server:read',
  'server:power',
  'server:reinstall',
  'server:delete',
  'server:settings',
  'server:resources',
  'server:console.read',
  'server:console.write',
  'server:mods',
  'server:files.read',
  'server:files.write',
  'server:backups',
  'server:network',
  'server:members',
  'server:integrations',
  'server:ai',
  'server:audit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = Object.freeze({
  owner: PERMISSIONS,
  admin: [
    'server:read', 'server:power', 'server:reinstall', 'server:settings',
    'server:resources', 'server:console.read', 'server:console.write',
    'server:mods', 'server:files.read', 'server:files.write', 'server:backups',
    'server:network', 'server:members', 'server:integrations', 'server:ai',
    'server:audit',
  ],
  operator: [
    'server:read', 'server:power', 'server:console.read', 'server:console.write',
    'server:mods', 'server:files.read', 'server:backups',
  ],
  viewer: ['server:read', 'server:console.read'],
});

export interface ResourceAllocation {
  /** Fractional CPU cores. 4 == four full cores. */
  cpuCores: number;
  /** Explicit CPU set pinning, e.g. "0-3". Null lets the scheduler choose. */
  cpuSet: string | null;
  memoryMib: number;
  storageGib: number;
  bandwidthMbps: number;
  /** Monthly transfer allowance in GiB. 0 = unmetered. */
  transferQuotaGib: number;
  slots: number;
}

export interface ServerPorts {
  /** Base port allocated on the node. Every game port is base + offset. */
  base: number;
  /** Publicly reachable address:port advertised to players. */
  publicHost: string;
  publicBase: number;
  map: Record<string, { internal: number; external: number; protocol: 'udp' | 'tcp' }>;
}

export interface ServerSummary {
  id: string;
  name: string;
  game: GameId;
  state: ServerState;
  nodeId: string;
  region: string;
  slots: number;
  playersOnline: number;
  address: string;
  suspended: boolean;
  createdAt: string;
}

export interface ServerStatsSample {
  at: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  playersOnline: number;
  /** Server frame rate where the game reports it. */
  fps: number | null;
}

export type ConsoleLineStream = 'stdout' | 'stderr' | 'rcon' | 'panel';

export interface ConsoleLine {
  seq: number;
  at: string;
  stream: ConsoleLineStream;
  text: string;
}

export interface ModEntry {
  /** Workshop id: Steam file id for Arma 3, GUID for Reforger. */
  modId: string;
  name: string;
  /** Pinned version, or null to always track latest. */
  version: string | null;
  enabled: boolean;
  /** Explicit load order; lower loads first. */
  order: number;
  required: boolean;
  sizeBytes: number | null;
}

export interface ModPreset {
  id: string;
  name: string;
  gameId: GameId;
  mods: ModEntry[];
  createdAt: string;
  updatedAt: string;
}

export type PortMappingMethod = 'upnp' | 'natpmp' | 'pcp' | 'relay' | 'manual' | 'direct';

export interface PortMappingStatus {
  method: PortMappingMethod;
  externalPort: number;
  internalPort: number;
  protocol: 'udp' | 'tcp';
  active: boolean;
  /** Remaining lease seconds, null for permanent/manual mappings. */
  leaseSeconds: number | null;
  lastVerifiedAt: string | null;
  reachable: boolean | null;
  message: string | null;
}

export interface HostRequirementCheck {
  key: 'memory' | 'cpu' | 'storage' | 'download' | 'upload';
  label: string;
  required: string;
  detected: string;
  pass: boolean;
}

export interface HostRequirementReport {
  pass: boolean;
  checkedAt: string;
  checks: HostRequirementCheck[];
  /** True when the network portion is stale and needs a fresh speed test. */
  networkStale: boolean;
}

export type AiProviderId = 'anthropic' | 'openai' | 'openai-codex' | 'custom';

export interface AiProviderConfig {
  id: string;
  provider: AiProviderId;
  label: string;
  model: string;
  /** Custom OpenAI-compatible base URL. Validated against SSRF rules. */
  baseUrl: string | null;
  enabled: boolean;
  /** Actions the assistant is permitted to take without a human confirming. */
  autonomousActions: Permission[];
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Present only for validation failures. */
    details?: Array<{ path: string; message: string }>;
    requestId: string;
  };
}
