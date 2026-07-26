/**
 * Environment configuration.
 *
 * Fails closed: the process refuses to boot if a security-relevant variable is
 * missing, too weak, or set to a known placeholder. There are no silent
 * defaults for secrets.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';

const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'password123',
  'replace-me',
  'your-secret-here',
  'insecure',
  'test',
]);

/** A 32-byte key, supplied as 64 hex characters or 44 base64 characters. */
const keySchema = z
  .string()
  .min(32)
  .superRefine((value, ctx) => {
    if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Refusing to start with a placeholder secret' });
      return;
    }
    const bytes = decodeKey(value);
    if (bytes === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be 64 hex characters or 44 base64 characters' });
      return;
    }
    if (bytes.length !== 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must decode to exactly 32 bytes (got ${bytes.length})` });
      return;
    }
    // Reject an all-zero or single-repeated-byte key outright.
    if (bytes.every((b) => b === bytes[0])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Key has no entropy' });
    }
  });

function decodeKey(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, 'base64');
  return null;
}

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    /** Canonical public origin of the web app. Used for CORS, cookies and OAuth. */
    PUBLIC_APP_URL: z.string().url(),
    /** Canonical public origin of the API, if it differs. */
    PUBLIC_API_URL: z.string().url().optional(),

    DATABASE_URL: z.string().min(1),

    /** Master key for AES-256-GCM envelope encryption of secrets at rest. */
    ENCRYPTION_KEY: keySchema,
    /** Previous key, kept during rotation so old envelopes still decrypt. */
    ENCRYPTION_KEY_PREVIOUS: keySchema.optional(),
    /** Key for salting IP/user-agent hashes so they are not brute-forceable. */
    HASH_PEPPER: keySchema,

    /** Optional Redis for distributed rate limiting. Falls back to Postgres. */
    REDIS_URL: z.string().url().optional(),

    /** Discord OAuth. Registration via Discord is disabled when unset. */
    DISCORD_CLIENT_ID: z.string().min(10).optional(),
    DISCORD_CLIENT_SECRET: z.string().min(10).optional(),

    /** Docker connection for the local node. */
    DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
    DOCKER_HOST: z.string().optional(),
    DOCKER_TLS_CA: z.string().optional(),
    DOCKER_TLS_CERT: z.string().optional(),
    DOCKER_TLS_KEY: z.string().optional(),

    /** Root directory on this host for game server volumes. */
    DATA_ROOT: z.string().min(1).default('/var/lib/arma-server-panel/servers'),

    /**
     * Where the per-game Dockerfiles live, as seen from inside the API
     * container. Compose mounts the repository's docker/ directory here so the
     * panel can build a game image the first time it is needed.
     */
    GAME_IMAGE_ROOT: z.string().min(1).default('/opt/asp/docker'),

    /** Steam credentials for downloading the Arma 3 dedicated server. */
    STEAM_USERNAME: z.string().optional(),
    STEAM_PASSWORD: z.string().optional(),

    /** Public address players connect to for this node. */
    PUBLIC_GAME_HOST: z.string().min(1).optional(),

    /** Relay egress used to keep self-hosters' home IPs private. */
    RELAY_ENABLED: boolish.default(false),
    RELAY_ENDPOINT: z.string().optional(),
    RELAY_TOKEN: z.string().optional(),

    /** Endpoints used by the mandatory throughput test. */
    SPEEDTEST_DOWNLOAD_URL: z.string().url().default('https://speed.cloudflare.com/__down?bytes=52428800'),
    SPEEDTEST_UPLOAD_URL: z.string().url().default('https://speed.cloudflare.com/__up'),
    /** Set only for air-gapped installs where the operator attests capacity. */
    SPEEDTEST_MANUAL_DOWNLOAD_MBPS: z.coerce.number().int().min(0).optional(),
    SPEEDTEST_MANUAL_UPLOAD_MBPS: z.coerce.number().int().min(0).optional(),

    /**
     * Anonymous usage reporting. Sends a random instance id, the panel
     * version, and counts. Never an address, hostname, server name or secret.
     * Off unless explicitly enabled by the operator.
     */
    TELEMETRY_ENABLED: boolish.default(false),
    TELEMETRY_ENDPOINT: z.string().url().default('https://armaserverpanel.io/api/telemetry'),

    /** Trust X-Forwarded-For. Only enable behind a proxy you control. */
    TRUST_PROXY: boolish.default(false),
    /** Comma-separated proxy CIDRs whose forwarded headers are honoured. */
    TRUSTED_PROXY_CIDRS: z.string().default(''),

    /** Disable in production only if TLS terminates in front of the API. */
    REQUIRE_SECURE_COOKIES: boolish.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.PUBLIC_APP_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_APP_URL'],
          message: 'Production requires an https origin',
        });
      }
      if (!env.REQUIRE_SECURE_COOKIES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REQUIRE_SECURE_COOKIES'],
          message: 'Secure cookies cannot be disabled in production',
        });
      }
      if (env.ENCRYPTION_KEY === env.HASH_PEPPER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['HASH_PEPPER'],
          message: 'HASH_PEPPER must differ from ENCRYPTION_KEY',
        });
      }
    }
    if (env.TRUST_PROXY && env.TRUSTED_PROXY_CIDRS.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message: 'TRUST_PROXY requires an explicit TRUSTED_PROXY_CIDRS allowlist',
      });
    }
    if (env.RELAY_ENABLED && (!env.RELAY_ENDPOINT || !env.RELAY_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RELAY_ENDPOINT'],
        message: 'RELAY_ENABLED requires RELAY_ENDPOINT and RELAY_TOKEN',
      });
    }
    if (Boolean(env.DISCORD_CLIENT_ID) !== Boolean(env.DISCORD_CLIENT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DISCORD_CLIENT_SECRET'],
        message: 'Set both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or neither',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends RawEnv {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  encryptionKey: Buffer;
  encryptionKeyPrevious: Buffer | null;
  hashPepper: Buffer;
  appOrigin: string;
  apiOrigin: string;
  discordEnabled: boolean;
  trustedProxyCidrs: string[];
}

let cached: AppConfig | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  // Docker Compose renders an unset `${VAR:-}` as an empty string rather than
  // omitting it. An empty string is not the same as "not configured" to Zod,
  // so optional fields would fail their own length rules. Strip blanks first
  // and let `.optional()` and `.default()` do their job.
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `Invalid environment configuration. Refusing to start.\n${lines.join('\n')}\n\n` +
        `Generate keys with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  const env = parsed.data;
  const encryptionKey = decodeKey(env.ENCRYPTION_KEY)!;
  const hashPepper = decodeKey(env.HASH_PEPPER)!;
  const encryptionKeyPrevious = env.ENCRYPTION_KEY_PREVIOUS
    ? decodeKey(env.ENCRYPTION_KEY_PREVIOUS)
    : null;

  cached = {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    encryptionKey,
    encryptionKeyPrevious,
    hashPepper,
    appOrigin: new URL(env.PUBLIC_APP_URL).origin,
    apiOrigin: new URL(env.PUBLIC_API_URL ?? env.PUBLIC_APP_URL).origin,
    discordEnabled: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS.split(',').map((s) => s.trim()).filter(Boolean),
  };

  return cached;
}

/** Test helper. Never called by the running server. */
export function resetConfigForTests(): void {
  cached = null;
}

/** Convenience for generating keys during setup. */
export function generateKey(): string {
  return randomBytes(32).toString('hex');
}
