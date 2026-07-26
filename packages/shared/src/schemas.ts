import { z } from 'zod';
import { GAME_IDS } from './games.js';
import { PERMISSIONS } from './types.js';
import { RESOURCE_LIMITS, USERNAME_POLICY, CONSOLE_LIMITS, FILE_MANAGER } from './constants.js';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const cuidSchema = z.string().min(20).max(40).regex(/^[a-z0-9]+$/i, 'Invalid id');

export const usernameSchema = z
  .string()
  .min(USERNAME_POLICY.minLength)
  .max(USERNAME_POLICY.maxLength);

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/, 'Invalid recovery code');

/**
 * Admin password policy. Deliberately strict: this account can reach every
 * server on the node.
 */
export const adminPasswordSchema = z
  .string()
  .min(14, 'Password must be at least 14 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine((v) => /[a-z]/.test(v), 'Must include a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Must include an uppercase letter')
  .refine((v) => /\d/.test(v), 'Must include a digit')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Must include a symbol')
  .refine((v) => !/(.)\1{3,}/.test(v), 'Must not repeat a character four or more times')
  .refine(
    (v) => !['password123', 'admin', 'administrator', 'letmein', 'changeme'].some((bad) =>
      v.toLowerCase().includes(bad),
    ),
    'Password contains a well-known weak phrase',
  );

/** Server names are shown publicly, so keep them printable and bounded. */
export const serverNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[\p{L}\p{N} .,'\-_|[\]()!#:+]+$/u, 'Server name contains unsupported characters');

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const registerStartSchema = z.object({
  username: usernameSchema,
  /** Present when the account is being linked from a completed Discord flow. */
  discordLinkToken: z.string().min(16).max(256).optional(),
  acceptedTerms: z.literal(true),
});

export const registerCompleteSchema = z.object({
  enrollmentToken: z.string().min(16).max(256),
  code: totpCodeSchema,
});

export const loginStartSchema = z.object({
  username: usernameSchema,
});

export const loginVerifySchema = z.object({
  challengeToken: z.string().min(16).max(256),
  code: z.union([totpCodeSchema, recoveryCodeSchema]),
});

export const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const adminChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: adminPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  });

export const totpEnrollConfirmSchema = z.object({
  code: totpCodeSchema,
});

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

const { cpu, memoryMib, storageGib, bandwidthMbps, transferQuotaGib, slots } = RESOURCE_LIMITS;

export const resourceAllocationSchema = z.object({
  cpuCores: z
    .number()
    .min(cpu.min)
    .max(cpu.max)
    .refine((v) => Number.isInteger(v / cpu.step), `CPU must be a multiple of ${cpu.step}`),
  cpuSet: z
    .string()
    .regex(/^\d{1,3}(-\d{1,3})?(,\d{1,3}(-\d{1,3})?)*$/, 'Invalid CPU set')
    .max(128)
    .nullable()
    .default(null),
  memoryMib: z
    .number()
    .int()
    .min(memoryMib.min, `Minimum ${memoryMib.min / 1024} GB of RAM`)
    .max(memoryMib.max, `Maximum ${memoryMib.max / 1024} GB of RAM`)
    .refine((v) => v % memoryMib.step === 0, 'RAM must be a whole number of GB'),
  storageGib: z.number().int().min(storageGib.min).max(storageGib.max),
  bandwidthMbps: z.number().int().min(bandwidthMbps.min).max(bandwidthMbps.max),
  transferQuotaGib: z.number().int().min(transferQuotaGib.min).max(transferQuotaGib.max),
  slots: z.number().int().min(slots.min).max(slots.max),
});

/* ------------------------------------------------------------------ */
/* Servers                                                             */
/* ------------------------------------------------------------------ */

export const createServerSchema = z.object({
  name: serverNameSchema,
  game: z.enum(GAME_IDS),
  nodeId: cuidSchema,
  resources: resourceAllocationSchema,
  /** Optional preset applied immediately after install. */
  modPresetId: cuidSchema.optional(),
  /** Ask the panel to open ports automatically after provisioning. */
  autoPortForward: z.boolean().default(true),
  /** Route public traffic through a relay so the host IP is never revealed. */
  useRelay: z.boolean().default(false),
});

export const updateServerSchema = z.object({
  name: serverNameSchema.optional(),
  description: z.string().max(500).optional(),
  autoStart: z.boolean().optional(),
  /** Restart automatically when the process exits unexpectedly. */
  autoRestart: z.boolean().optional(),
  crashRestartLimit: z.number().int().min(0).max(20).optional(),
});

export const powerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill', 'reinstall']),
  /** Reinstall is destructive; require an explicit typed confirmation. */
  confirmation: z.string().max(64).optional(),
});

export const consoleCommandSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(CONSOLE_LIMITS.maxCommandLength)
    // Reject control characters outright - they are never legitimate here and
    // are the classic vector for terminal escape-sequence injection.
    .refine((v) => !/[\x00-\x1F\x7F\u2028\u2029]/.test(v), 'Command contains control characters'),
});

/* ------------------------------------------------------------------ */
/* Mods                                                                */
/* ------------------------------------------------------------------ */

export const modEntrySchema = z.object({
  modId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    // Steam file ids are numeric; Reforger workshop ids are uppercase hex GUIDs.
    .regex(/^[A-Za-z0-9]+$/, 'Invalid mod id'),
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().max(32).nullable().default(null),
  enabled: z.boolean().default(true),
  order: z.number().int().min(0).max(4096),
  required: z.boolean().default(false),
});

export const setModsSchema = z.object({
  mods: z.array(modEntrySchema).max(512),
});

export const createModPresetSchema = z.object({
  name: z.string().trim().min(1).max(64),
  game: z.enum(GAME_IDS),
  mods: z.array(modEntrySchema).max(512),
});

export const importModPresetSchema = z.object({
  name: z.string().trim().min(1).max(64),
  game: z.enum(GAME_IDS),
  /** Raw preset payload: Arma 3 HTML preset export or Reforger JSON. */
  payload: z.string().max(2 * 1024 * 1024),
  format: z.enum(['arma3-html', 'reforger-json', 'asp-json']),
});

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/**
 * Path validation is defence in depth only - the file service additionally
 * resolves and re-checks containment against the server root.
 */
export const filePathSchema = z
  .string()
  .max(1024)
  .refine((v) => !v.includes('\0'), 'Path contains a null byte')
  .refine((v) => !v.split(/[\\/]/).includes('..'), 'Path traversal is not permitted')
  .refine((v) => !/^[a-zA-Z]:[\\/]/.test(v), 'Absolute paths are not permitted')
  .refine((v) => !v.startsWith('/') && !v.startsWith('\\'), 'Absolute paths are not permitted');

export const writeFileSchema = z.object({
  path: filePathSchema,
  content: z.string().max(FILE_MANAGER.maxEditableBytes),
});

export const listFilesSchema = z.object({
  path: filePathSchema.default(''),
});

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */

export const portForwardRequestSchema = z.object({
  /** Preferred method; the service falls back down the chain automatically. */
  preferred: z.enum(['auto', 'upnp', 'natpmp', 'pcp', 'relay', 'manual']).default('auto'),
  /** Lease duration in seconds; 0 asks for a permanent mapping. */
  leaseSeconds: z.number().int().min(0).max(604800).default(3600),
});

/* ------------------------------------------------------------------ */
/* Integrations                                                        */
/* ------------------------------------------------------------------ */

export const discordIntegrationSchema = z.object({
  /** Only real Discord webhook URLs; validated again at egress time. */
  webhookUrl: z
    .string()
    .url()
    .max(512)
    .refine(
      (v) => /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//.test(v),
      'Must be a Discord webhook URL',
    ),
  events: z.array(z.enum(['start', 'stop', 'crash', 'reinstall', 'update', 'player_join', 'player_leave', 'alert'])).min(1),
  enabled: z.boolean().default(true),
});

export const pushoverIntegrationSchema = z.object({
  userKey: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, 'Invalid Pushover user key'),
  apiToken: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, 'Invalid Pushover API token'),
  events: z.array(z.enum(['start', 'stop', 'crash', 'reinstall', 'update', 'alert'])).min(1),
  enabled: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */

export const createApiKeySchema = z.object({
  label: z.string().trim().min(1).max(64),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
  serverIds: z.array(cuidSchema).max(100).default([]),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  /** Optional CIDR allowlist for where the key may be used from. */
  allowedCidrs: z.array(z.string().max(64)).max(20).default([]),
});

/* ------------------------------------------------------------------ */
/* AI assistant                                                        */
/* ------------------------------------------------------------------ */

export const aiProviderSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openai-codex', 'custom']),
  label: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  apiKey: z.string().min(8).max(512),
  baseUrl: z.string().url().max(256).nullable().default(null),
  autonomousActions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
});

export const aiDiagnoseSchema = z.object({
  providerId: cuidSchema,
  question: z.string().trim().min(3).max(4000),
  /** Context the operator explicitly consents to sharing with the provider. */
  include: z
    .object({
      console: z.boolean().default(true),
      config: z.boolean().default(true),
      mods: z.boolean().default(true),
      metrics: z.boolean().default(true),
      files: z.array(filePathSchema).max(10).default([]),
    })
    .default({}),
});

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export const addMemberSchema = z.object({
  /** Either an existing panel username or a raw Discord user id. */
  identifier: z.string().trim().min(1).max(64),
  identifierType: z.enum(['username', 'discord_id']),
  role: z.enum(['admin', 'operator', 'viewer']),
  permissionOverrides: z.array(z.enum(PERMISSIONS)).optional(),
});

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export const paginationSchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type RegisterStartInput = z.infer<typeof registerStartSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type ResourceAllocationInput = z.infer<typeof resourceAllocationSchema>;
export type ModEntryInput = z.infer<typeof modEntrySchema>;
export type AiProviderInput = z.infer<typeof aiProviderSchema>;
