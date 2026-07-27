/**
 * Platform-wide constants.
 *
 * The values in HOST_REQUIREMENTS are a hard-coded floor mandated by the product
 * spec. They are enforced in three places and must not be made configurable:
 *   1. First-run setup wizard  (apps/api/src/modules/host/host-requirements.ts)
 *   2. Public registration     (apps/api/src/modules/auth/register.ts)
 *   3. Node registration       (apps/api/src/modules/nodes/node-service.ts)
 */

export const PANEL_NAME = 'Arma Server Panel' as const;
export const PANEL_SHORT_NAME = 'ASP' as const;

/** Immutable minimum host specification. Enforced, never configurable. */
export const HOST_REQUIREMENTS = Object.freeze({
  /** Minimum total physical memory, in bytes (8 GiB). */
  minMemoryBytes: 8 * 1024 ** 3,
  /** Minimum logical CPUs (cores or threads). */
  minCpuThreads: 4,
  /** Minimum total storage on the data volume, in bytes (120 GB, decimal as sold). */
  minStorageBytes: 120 * 1000 ** 3,
  /** Minimum measured downlink, in megabits per second. */
  minDownloadMbps: 50,
  /** Minimum measured uplink, in megabits per second. */
  minUploadMbps: 50,
  /** How long a passing speed test stays valid before it must be re-run. */
  speedTestTtlMs: 24 * 60 * 60 * 1000,
});

/** Per-game-server resource allocation bounds. */
export const RESOURCE_LIMITS = Object.freeze({
  cpu: {
    /** Fractional cores are allowed down to 0.5 so small test servers are possible. */
    min: 0.5,
    max: 64,
    step: 0.5,
    default: 4,
  },
  memoryMib: {
    /** Spec: RAM min 8 GB, up to 64 GB. */
    min: 8 * 1024,
    max: 64 * 1024,
    step: 1024,
    default: 8 * 1024,
  },
  storageGib: {
    min: 10,
    /** 8 TiB upper bound - the spec asks for GB/TB granularity. */
    max: 8 * 1024,
    step: 1,
    default: 60,
  },
  /** Sustained bandwidth cap applied via tc/ifb on the container veth. */
  bandwidthMbps: {
    min: 5,
    max: 10_000,
    step: 5,
    default: 100,
  },
  /** Monthly transfer quota in GiB. 0 = unmetered. */
  transferQuotaGib: {
    min: 0,
    max: 1_000_000,
    step: 100,
    default: 0,
  },
  slots: {
    min: 1,
    max: 256,
    default: 32,
  },
  pidsLimit: 512,
});

/** Pricing, mirrored from the marketing site. */
export const PRICING = Object.freeze({
  perSlotUsdMonthly: 1.2,
  currency: 'USD',
  trialDays: 7,
});

export const SESSION = Object.freeze({
  /**
   * The `__Host-` prefix is the strongest cookie binding available: the browser
   * only accepts it when the cookie is Secure, Path=/ and has no Domain, which
   * stops a sibling subdomain overwriting it (cookie tossing).
   *
   * It is rejected outright over plain HTTP, so a non-TLS deployment has to use
   * the unprefixed names. `sessionCookieNames()` picks the right pair.
   */
  cookieName: '__Host-asp_session',
  csrfCookieName: '__Host-asp_csrf',
  insecureCookieName: 'asp_session',
  insecureCsrfCookieName: 'asp_csrf',
  csrfHeaderName: 'x-asp-csrf',
  /** Rolling idle timeout. */
  idleTimeoutMs: 60 * 60 * 1000,
  /** Hard cap regardless of activity. */
  absoluteTimeoutMs: 12 * 60 * 60 * 1000,
  /** Elevated (admin) sessions expire much sooner. */
  adminIdleTimeoutMs: 20 * 60 * 1000,
  adminAbsoluteTimeoutMs: 4 * 60 * 60 * 1000,
  /** Bytes of entropy in the raw session token. */
  tokenBytes: 32,
  /** How often a session token is rotated while in use. */
  rotateAfterMs: 15 * 60 * 1000,
});

/**
 * "Remember this device" - skips the authenticator prompt on a browser that has
 * already proved it, for a bounded period.
 *
 * It only ever skips the *second* factor. The account is still identified, an
 * administrator still needs their password, and privileged admin actions still
 * require a fresh TOTP step-up. Revoked by signing out everywhere, changing a
 * password, or re-enrolling TOTP.
 */
export const TRUSTED_DEVICE = Object.freeze({
  cookieName: '__Host-asp_device',
  insecureCookieName: 'asp_device',
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  tokenBytes: 32,
  /** Most people do not have more than a handful of browsers. */
  maxPerAccount: 10,
});

export const TOTP = Object.freeze({
  issuer: PANEL_NAME,
  digits: 6,
  periodSeconds: 30,
  algorithm: 'SHA1' as const,
  /** Accept the immediately previous and next step to absorb clock drift. */
  windowSteps: 1,
  secretBytes: 20,
  recoveryCodeCount: 10,
  recoveryCodeBytes: 10,
});

/**
 * Cookie names for the current transport.
 *
 * Over TLS the `__Host-` prefixed pair is used. Over plain HTTP the browser
 * would discard those, so the unprefixed pair is used instead - the cookies are
 * still HttpOnly and SameSite=Strict, just without the prefix guarantee.
 */
export function sessionCookieNames(secure: boolean): { session: string; csrf: string } {
  return secure
    ? { session: SESSION.cookieName, csrf: SESSION.csrfCookieName }
    : { session: SESSION.insecureCookieName, csrf: SESSION.insecureCsrfCookieName };
}

/**
 * Username-abuse policy from the spec:
 *   1st rejected username  -> warning
 *   same username retried  -> 2 hour registration ban for that client
 */
export const USERNAME_POLICY = Object.freeze({
  minLength: 3,
  maxLength: 24,
  /** Attempts at *choosing* a username, per window, per client. */
  rateLimit: { points: 8, windowMs: 10 * 60 * 1000 },
  /** Ban applied when a rejected username is submitted a second time. */
  banDurationMs: 2 * 60 * 60 * 1000,
  /** How long a warning is remembered so the "second time" can be detected. */
  warningRetentionMs: 24 * 60 * 60 * 1000,
});

export const RATE_LIMITS = Object.freeze({
  global: { points: 600, windowMs: 60_000 },
  auth: { points: 10, windowMs: 60_000 },
  totpVerify: { points: 6, windowMs: 5 * 60_000 },
  register: { points: 5, windowMs: 15 * 60_000 },
  adminLogin: { points: 5, windowMs: 15 * 60_000 },
  serverPower: { points: 20, windowMs: 60_000 },
  reinstall: { points: 3, windowMs: 60 * 60_000 },
  apiKey: { points: 300, windowMs: 60_000 },
  ai: { points: 20, windowMs: 60 * 60_000 },
  console: { points: 60, windowMs: 60_000 },
});

/** Progressive lockout applied to admin password + TOTP verification. */
export const LOCKOUT = Object.freeze({
  thresholds: [
    { failures: 3, lockMs: 30_000 },
    { failures: 5, lockMs: 5 * 60_000 },
    { failures: 8, lockMs: 30 * 60_000 },
    { failures: 12, lockMs: 24 * 60 * 60_000 },
  ],
  /** Failure counter resets after this much quiet time. */
  decayMs: 24 * 60 * 60 * 1000,
});

export const CONSOLE_LIMITS = Object.freeze({
  /** Lines retained in the in-memory ring buffer served on console attach. */
  scrollbackLines: 2000,
  /** Max bytes of a single console line before truncation. */
  maxLineBytes: 8 * 1024,
  /** Max length of a command an operator may send. */
  maxCommandLength: 512,
  /** Persisted log retention - "for days, not minutes". */
  retentionDays: 14,
});

export const METRICS = Object.freeze({
  /** How often container stats are sampled. */
  sampleIntervalMs: 10_000,
  /** Raw sample retention before downsampling. */
  rawRetentionMs: 6 * 60 * 60 * 1000,
  /** Downsampled (1 minute) retention. */
  rolledRetentionMs: 30 * 24 * 60 * 60 * 1000,
});

/** Port ranges the allocator may hand out. Never overlaps privileged ports. */
export const PORT_ALLOCATION = Object.freeze({
  min: 20000,
  max: 40000,
  /** Ports reserved by the panel itself and never allocated to a game server. */
  reserved: [] as number[],
});

export const AUDIT = Object.freeze({
  /** Audit entries are hash-chained; this is the genesis value. */
  genesisHash: '0'.repeat(64),
  retentionDays: 400,
});

export const FILE_MANAGER = Object.freeze({
  maxUploadBytes: 512 * 1024 * 1024,
  maxEditableBytes: 4 * 1024 * 1024,
  /** Extensions that may be created or edited through the file manager. */
  editableExtensions: [
    '.json', '.cfg', '.txt', '.log', '.ini', '.xml', '.yml', '.yaml',
    '.sqf', '.hpp', '.ext', '.conf', '.properties', '.md', '.csv',
  ] as string[],
  /** Never listed, never served, never written. */
  deniedNames: ['.ssh', '.env', 'id_rsa', 'id_ed25519', '.git', '.docker'] as string[],
});
