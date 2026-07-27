/**
 * Declarative descriptions of every game config setting the panel can edit.
 *
 * These drive the settings form. They deliberately live beside the game
 * definitions rather than in the web app, for two reasons:
 *
 *   1. A hand-written form per game drifts out of sync with the adapter's zod
 *      schema the first time a field is added. A test asserts that every key
 *      here exists in that game's default config and that nothing editable is
 *      missing, so the drift is caught at build time instead of by an operator
 *      wondering why a setting does nothing.
 *
 *   2. The form is a convenience, never a gate. It produces an ordinary config
 *      object which goes through exactly the same server-side validation as a
 *      hand-edited one - so nothing here is a security control, and a field
 *      being absent from this list does not make it uneditable.
 *
 * Values are stored in whatever shape the game wants: Arma 3 writes numeric
 * 0/1 flags, Reforger writes real JSON booleans. `trueValue`/`falseValue` on a
 * toggle carry that difference so the form never has to know which game it is
 * rendering.
 */

import { GAMES, type GameId } from './games.js';

export type ConfigFieldKind = 'text' | 'password' | 'number' | 'toggle' | 'select' | 'stringList';

interface FieldBase {
  /** Dotted path into the config object, e.g. "difficulty.skillAI". */
  key: string;
  label: string;
  /** One line explaining what it does, shown under the control. */
  help?: string;
  group: string;
  /** Collapsed by default - correct for most operators to ignore. */
  advanced?: boolean;
}

export interface TextField extends FieldBase {
  kind: 'text' | 'password';
  maxLength?: number;
  placeholder?: string;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  min?: number;
  max?: number;
  step?: number;
  /** Rendered after the input, e.g. "seconds". Never part of the value. */
  unit?: string;
  /** Sends null rather than 0 when cleared. */
  nullable?: boolean;
}

export interface ToggleField extends FieldBase {
  kind: 'toggle';
  /** What "on" is stored as. Numeric for Arma 3, boolean for Reforger. */
  trueValue: number | boolean;
  falseValue: number | boolean;
}

export interface SelectField extends FieldBase {
  kind: 'select';
  options: ReadonlyArray<{ value: string | number; label: string }>;
}

export interface StringListField extends FieldBase {
  kind: 'stringList';
  placeholder?: string;
  maxItems?: number;
}

export type ConfigField = TextField | NumberField | ToggleField | SelectField | StringListField;

/* ------------------------------------------------------------------ */
/* Path access                                                         */
/* ------------------------------------------------------------------ */

/** Reads a dotted path. Returns undefined rather than throwing on a gap. */
export function getConfigValue(config: unknown, key: string): unknown {
  let current: unknown = config;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Returns a copy of `config` with `key` set to `value`.
 *
 * Copies each level it descends through, so the caller's object is never
 * mutated - React state depends on that.
 */
export function setConfigValue(
  config: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const segments = key.split('.');
  const root = { ...config };

  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    const next =
      typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[segment] = next;
    cursor = next;
  }

  cursor[segments[segments.length - 1]!] = value;
  return root;
}

/* ------------------------------------------------------------------ */
/* Arma 3                                                              */
/* ------------------------------------------------------------------ */

const flag = { kind: 'toggle', trueValue: 1, falseValue: 0 } as const;

/** 0 = never, 1 = limited, 2 = always - Arma's own triple. */
const VISIBILITY_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'Limited' },
  { value: 2, label: 'Always' },
] as const;

const ARMA3_FIELDS: ConfigField[] = [
  /* Identity */
  {
    key: 'hostname',
    label: 'Server name',
    help: 'Shown in the server browser. Separate from the panel’s own name for this server.',
    group: 'Identity',
    kind: 'text',
    maxLength: 96,
  },
  {
    key: 'password',
    label: 'Join password',
    help: 'Leave empty for a public server.',
    group: 'Identity',
    kind: 'password',
    maxLength: 64,
  },
  {
    key: 'maxPlayers',
    label: 'Max players',
    help: 'Cannot exceed the slots allocated to this server above.',
    group: 'Identity',
    kind: 'number',
    min: 1,
    max: GAMES.arma3.maxSlots,
  },
  {
    key: 'motd',
    label: 'Message of the day',
    help: 'One line per entry, shown to players on join.',
    group: 'Identity',
    kind: 'stringList',
    placeholder: 'Welcome to the server',
    maxItems: 10,
  },
  {
    key: 'motdInterval',
    label: 'MOTD interval',
    group: 'Identity',
    kind: 'number',
    min: 0,
    max: 3600,
    unit: 'seconds',
  },

  /* Joining rules */
  {
    key: 'verifySignatures',
    label: 'Signature verification',
    help: 'Rejects clients whose mods are not signed with a key the server trusts.',
    group: 'Joining rules',
    kind: 'select',
    options: [
      { value: 2, label: 'Enabled (recommended)' },
      { value: 0, label: 'Disabled' },
    ],
  },
  {
    key: 'allowedFilePatching',
    label: 'File patching',
    help: 'Lets a client load loose scripts over the mission’s own. Keep closed unless a mod needs it.',
    group: 'Joining rules',
    kind: 'select',
    options: [
      { value: 0, label: 'Nobody' },
      { value: 1, label: 'Headless clients only' },
      { value: 2, label: 'Everybody' },
    ],
  },
  {
    key: 'kickDuplicate',
    label: 'Kick duplicate player IDs',
    group: 'Joining rules',
    ...flag,
  },
  {
    key: 'requiredBuild',
    label: 'Required game build',
    help: 'Clients on an older build are rejected. Leave empty for any build.',
    group: 'Joining rules',
    kind: 'number',
    min: 0,
    max: 999999,
    nullable: true,
    advanced: true,
  },
  {
    key: 'loopback',
    label: 'Loopback (LAN only)',
    help: 'Stops the server registering with Steam. Only for an isolated network.',
    group: 'Joining rules',
    advanced: true,
    ...flag,
  },

  /* Whitelists */
  {
    key: 'admins',
    label: 'Server admins',
    help: 'Steam64 IDs. These players can log in as admin without the password.',
    group: 'Whitelists',
    kind: 'stringList',
    placeholder: '76561198000000000',
    maxItems: 64,
  },
  {
    key: 'headlessClients',
    label: 'Headless client IPs',
    group: 'Whitelists',
    kind: 'stringList',
    placeholder: '127.0.0.1',
    maxItems: 16,
    advanced: true,
  },
  {
    key: 'localClient',
    label: 'Local client IPs',
    help: 'Given unlimited bandwidth. Normally the same addresses as the headless clients.',
    group: 'Whitelists',
    kind: 'stringList',
    placeholder: '127.0.0.1',
    maxItems: 16,
    advanced: true,
  },

  /* Voting */
  {
    key: 'voteThreshold',
    label: 'Vote threshold',
    help: 'Share of players needed to pass a vote. 0 disables voting entirely.',
    group: 'Voting',
    kind: 'number',
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    key: 'voteMissionPlayers',
    label: 'Players before mission voting',
    group: 'Voting',
    kind: 'number',
    min: 1,
    max: 256,
  },

  /* Gameplay */
  { key: 'persistent', label: 'Persistent mission', group: 'Gameplay', ...flag },
  { key: 'battleEye', label: 'BattlEye anti-cheat', group: 'Gameplay', ...flag },
  { key: 'drawingInMap', label: 'Allow drawing on the map', group: 'Gameplay', ...flag },
  { key: 'disableVoN', label: 'Disable voice over net', group: 'Gameplay', ...flag },
  {
    key: 'vonCodec',
    label: 'Voice codec',
    group: 'Gameplay',
    kind: 'select',
    options: [
      { value: 1, label: 'Opus (recommended)' },
      { value: 0, label: 'Legacy Speex' },
    ],
  },
  {
    key: 'vonCodecQuality',
    label: 'Voice quality',
    help: 'Higher is clearer and uses more bandwidth.',
    group: 'Gameplay',
    kind: 'number',
    min: 0,
    max: 30,
  },
  {
    key: 'forceRotorLibSimulation',
    label: 'Helicopter flight model',
    group: 'Gameplay',
    kind: 'select',
    options: [
      { value: 0, label: 'Player’s choice' },
      { value: 1, label: 'Force advanced' },
      { value: 2, label: 'Force basic' },
    ],
  },
  {
    key: 'timeStampFormat',
    label: 'Log timestamps',
    group: 'Gameplay',
    kind: 'select',
    options: [
      { value: 'none', label: 'None' },
      { value: 'short', label: 'Short' },
      { value: 'full', label: 'Full' },
    ],
  },
  {
    key: 'logFile',
    label: 'Log file name',
    group: 'Gameplay',
    kind: 'text',
    maxLength: 64,
    advanced: true,
  },

  /* Network */
  {
    key: 'disconnectTimeout',
    label: 'Disconnect timeout',
    help: 'How long a player may drop out before the server releases their slot.',
    group: 'Network',
    kind: 'number',
    min: 5,
    max: 90,
    unit: 'seconds',
  },
  { key: 'maxPing', label: 'Max ping', group: 'Network', kind: 'number', min: 0, max: 1000, unit: 'ms' },
  { key: 'maxDesync', label: 'Max desync', group: 'Network', kind: 'number', min: 0, max: 1000 },
  {
    key: 'maxPacketLoss',
    label: 'Max packet loss',
    group: 'Network',
    kind: 'number',
    min: 0,
    max: 100,
    unit: '%',
  },

  /* basic.cfg - bandwidth and packet tuning */
  {
    key: 'network.minBandwidth',
    label: 'Guaranteed bandwidth',
    help: 'Rough guide: 256 kbit per player. Arma’s own default is 131072 (128 kbit), which throttles a modern connection.',
    group: 'Network',
    kind: 'number',
    min: 131072,
    max: 1000000000,
    step: 1024,
    unit: 'bps',
  },
  {
    key: 'network.maxBandwidth',
    label: 'Bandwidth ceiling',
    help: 'Lower this when several servers share one link.',
    group: 'Network',
    kind: 'number',
    min: 131072,
    max: 1000000000,
    step: 1024,
    unit: 'bps',
  },
  {
    key: 'network.maxMsgSend',
    label: 'Packets per frame',
    help: 'Higher cuts lag but raises desync.',
    group: 'Network',
    kind: 'number',
    min: 16,
    max: 8192,
    advanced: true,
  },
  {
    key: 'network.maxSizeGuaranteed',
    label: 'Guaranteed packet size',
    group: 'Network',
    kind: 'number',
    min: 128,
    max: 2048,
    unit: 'bytes',
    advanced: true,
  },
  {
    key: 'network.maxSizeNonguaranteed',
    label: 'Non-guaranteed packet size',
    help: 'Guidance is half the guaranteed size. The largest single factor in desync.',
    group: 'Network',
    kind: 'number',
    min: 64,
    max: 1024,
    unit: 'bytes',
    advanced: true,
  },
  {
    key: 'network.minErrorToSend',
    label: 'Update threshold, far units',
    help: 'Smaller is smoother at long range and costs more traffic.',
    group: 'Network',
    kind: 'number',
    min: 0.001,
    max: 1,
    step: 0.001,
    advanced: true,
  },
  {
    key: 'network.minErrorToSendNear',
    label: 'Update threshold, near units',
    group: 'Network',
    kind: 'number',
    min: 0.001,
    max: 1,
    step: 0.001,
    advanced: true,
  },
  {
    key: 'network.maxCustomFileSize',
    label: 'Max custom file size',
    help: 'Player face and sound uploads. 0 blocks them entirely.',
    group: 'Network',
    kind: 'number',
    min: 0,
    max: 10000000,
    unit: 'bytes',
    advanced: true,
  },

  /* Difficulty */
  {
    key: 'forcedDifficulty',
    label: 'Forced difficulty',
    help: 'The options below apply only when this is set to Custom.',
    group: 'Difficulty',
    kind: 'select',
    options: [
      { value: 'Recruit', label: 'Recruit' },
      { value: 'Regular', label: 'Regular' },
      { value: 'Veteran', label: 'Veteran' },
      { value: 'Custom', label: 'Custom' },
    ],
  },
  ...(
    [
      ['groupIndicators', 'Group indicators'],
      ['friendlyTags', 'Friendly name tags'],
      ['enemyTags', 'Enemy name tags'],
      ['detectedMines', 'Detected mines'],
      ['commands', 'Command markers'],
      ['waypoints', 'Waypoints'],
      ['weaponInfo', 'Weapon info'],
      ['stanceIndicator', 'Stance indicator'],
    ] as const
  ).map(
    ([key, label]): ConfigField => ({
      key: `difficulty.${key}`,
      label,
      group: 'Difficulty',
      advanced: true,
      kind: 'select',
      options: VISIBILITY_OPTIONS,
    }),
  ),
  ...(
    [
      ['reducedDamage', 'Reduced damage'],
      ['staminaBar', 'Stamina bar'],
      ['weaponCrosshair', 'Weapon crosshair'],
      ['visionAid', 'Vision aid'],
      ['thirdPersonView', 'Third person view'],
      ['cameraShake', 'Camera shake'],
      ['scoreTable', 'Score table'],
      ['deathMessages', 'Death messages'],
      ['vonID', 'Show who is speaking'],
      ['mapContent', 'Extended map content'],
      ['autoReport', 'Auto-report enemies'],
      ['multipleSaves', 'Multiple saves'],
    ] as const
  ).map(
    ([key, label]): ConfigField => ({
      key: `difficulty.${key}`,
      label,
      group: 'Difficulty',
      advanced: true,
      ...flag,
    }),
  ),
  {
    key: 'difficulty.aiLevelPreset',
    label: 'AI level',
    group: 'Difficulty',
    advanced: true,
    kind: 'select',
    options: [
      { value: 0, label: 'Low' },
      { value: 1, label: 'Normal' },
      { value: 2, label: 'High' },
      { value: 3, label: 'Custom (use the sliders below)' },
    ],
  },
  {
    key: 'difficulty.skillAI',
    label: 'AI skill',
    group: 'Difficulty',
    advanced: true,
    kind: 'number',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'difficulty.precisionAI',
    label: 'AI precision',
    group: 'Difficulty',
    advanced: true,
    kind: 'number',
    min: 0,
    max: 1,
    step: 0.05,
  },
];

/* ------------------------------------------------------------------ */
/* Arma Reforger                                                       */
/* ------------------------------------------------------------------ */

const bool = { kind: 'toggle', trueValue: true, falseValue: false } as const;

const REFORGER_FIELDS: ConfigField[] = [
  /* Identity */
  {
    key: 'serverName',
    label: 'Server name',
    group: 'Identity',
    kind: 'text',
    maxLength: 100,
  },
  {
    key: 'serverPassword',
    label: 'Join password',
    help: 'Leave empty for a public server.',
    group: 'Identity',
    kind: 'password',
    maxLength: 64,
  },
  // No admin password field: Reforger's `passwordAdmin` is generated per server
  // and stored encrypted, not kept in the editable config.
  {
    key: 'maxPlayers',
    label: 'Max players',
    help: 'Cannot exceed the slots allocated to this server above.',
    group: 'Identity',
    kind: 'number',
    min: 1,
    max: GAMES.reforger.maxSlots,
  },
  {
    key: 'scenarioId',
    label: 'Scenario',
    help: 'The mission the server loads, e.g. {ECC61978EDCC2B5A}Missions/23_Campaign.conf',
    group: 'Identity',
    kind: 'text',
    maxLength: 256,
  },

  /* Visibility */
  {
    key: 'visible',
    label: 'List in the server browser',
    group: 'Visibility',
    ...bool,
  },
  {
    key: 'crossPlatform',
    label: 'Allow cross-platform play',
    group: 'Visibility',
    ...bool,
  },
  {
    key: 'a2sEnabled',
    label: 'Answer A2S queries',
    help: 'Turning this off also stops the panel reporting a player count.',
    group: 'Visibility',
    advanced: true,
    ...bool,
  },

  /* Joining rules */
  { key: 'battlEye', label: 'BattlEye anti-cheat', group: 'Joining rules', ...bool },
  {
    key: 'fastValidation',
    label: 'Fast mod validation',
    help: 'Leave on. Turning it off makes joining much slower on a heavily modded server.',
    group: 'Joining rules',
    advanced: true,
    ...bool,
  },
  {
    key: 'admins',
    label: 'Server admins',
    help: 'Identity IDs, not Steam IDs. Found in the player’s profile.',
    group: 'Joining rules',
    kind: 'stringList',
    maxItems: 64,
  },

  /* Gameplay */
  { key: 'disableThirdPerson', label: 'Force first person', group: 'Gameplay', ...bool },
  {
    key: 'aiLimit',
    label: 'AI limit',
    help: '-1 for no limit. Lowering this is the single most effective way to cut server load.',
    group: 'Gameplay',
    kind: 'number',
    min: -1,
    max: 1000,
  },
  {
    key: 'playerSaveTime',
    label: 'Player save interval',
    group: 'Gameplay',
    kind: 'number',
    min: 30,
    max: 3600,
    unit: 'seconds',
  },
  {
    key: 'slotReservationTimeout',
    label: 'Slot reservation timeout',
    help: 'How long a disconnected player’s slot is held for them to rejoin.',
    group: 'Gameplay',
    kind: 'number',
    min: 5,
    max: 300,
    unit: 'seconds',
    advanced: true,
  },
  {
    key: 'autoReload',
    label: 'Auto-reload scenario',
    help: '0 disables it. Otherwise the scenario restarts after this long.',
    group: 'Gameplay',
    kind: 'number',
    min: 0,
    max: 3600,
    unit: 'seconds',
  },

  /* Performance */
  {
    key: 'serverMaxViewDistance',
    label: 'Max view distance',
    group: 'Performance',
    kind: 'number',
    min: 500,
    max: 10000,
    unit: 'm',
  },
  {
    key: 'networkViewDistance',
    label: 'Network view distance',
    help: 'How far away players are streamed to each other. The biggest bandwidth lever.',
    group: 'Performance',
    kind: 'number',
    min: 500,
    max: 5000,
    unit: 'm',
  },
  {
    key: 'serverMinGrassDistance',
    label: 'Min grass distance',
    group: 'Performance',
    kind: 'number',
    min: 0,
    max: 150,
    unit: 'm',
  },

  /* RCON */
  {
    key: 'rconEnabled',
    label: 'Enable RCON',
    help: 'Required for the panel’s console to send commands to this server.',
    group: 'RCON',
    ...bool,
  },
  {
    key: 'rconPermission',
    label: 'RCON permission',
    group: 'RCON',
    advanced: true,
    kind: 'select',
    options: [
      { value: 'admin', label: 'Admin (can run commands)' },
      { value: 'monitor', label: 'Monitor (read only)' },
    ],
  },
];

/* ------------------------------------------------------------------ */

/**
 * Fields the settings form can render, per game.
 *
 * A game absent from here - or a key absent from its list - is still fully
 * editable through the JSON editor. Arma 4 has no entry because it has not
 * shipped and its config is a placeholder.
 */
export const CONFIG_FIELDS: Readonly<Record<GameId, readonly ConfigField[]>> = Object.freeze({
  arma3: ARMA3_FIELDS,
  reforger: REFORGER_FIELDS,
  arma4: [],
});

/** Group order as declared, without duplicates. */
export function configGroups(fields: readonly ConfigField[]): string[] {
  const seen: string[] = [];
  for (const field of fields) {
    if (!seen.includes(field.group)) seen.push(field.group);
  }
  return seen;
}

/**
 * Config keys with no field descriptor.
 *
 * Surfaced in the UI so an operator can see at a glance what the form does not
 * cover, rather than assuming the form is the whole config.
 */
export function unmappedConfigKeys(
  config: Record<string, unknown>,
  fields: readonly ConfigField[],
): string[] {
  const covered = new Set(fields.map((field) => field.key.split('.')[0]));
  return Object.keys(config)
    .filter((key) => !covered.has(key))
    .sort();
}
