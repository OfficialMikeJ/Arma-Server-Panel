/**
 * SSRF-safe outbound HTTP.
 *
 * The panel makes outbound requests on behalf of users in three places:
 * Discord/Pushover webhooks, AI provider endpoints, and mod metadata lookups.
 * Each is a chance for a user to point us at 169.254.169.254 or an internal
 * service, so all of them go through `safeFetch`.
 *
 * Two things make this more than a naive URL check:
 *   * DNS is resolved *by us*, every resolved address is validated, and the
 *     connection is then pinned to the address we validated. That closes the
 *     DNS-rebinding window between check and connect.
 *   * Redirects are followed manually, re-validating each hop.
 */

import { Agent, request as undiciRequest, type Dispatcher } from 'undici';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { isPrivateAddress } from './client-identity.js';
import { logger } from '../lib/logger.js';

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Host allowlist. When set, the URL host must match one of these exactly. */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxRedirects?: number;
  /** Cap on the response body we will buffer. */
  maxResponseBytes?: number;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRedirects: 3,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function assertHttps(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Only https is permitted (got ${url.protocol})`, url.toString());
  }
}

function assertHostAllowed(url: URL, allowedHosts?: readonly string[]): void {
  if (!allowedHosts || allowedHosts.length === 0) return;
  const host = url.hostname.toLowerCase();
  const permitted = allowedHosts.some(
    (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`),
  );
  if (!permitted) {
    throw new SsrfBlockedError(`Host ${host} is not on the allowlist`, url.toString());
  }
}

/** Resolves the host and rejects if any answer is a non-public address. */
async function resolvePublicAddress(hostname: string): Promise<LookupAddress> {
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfBlockedError(`Address ${hostname} is not publicly routable`, hostname);
    }
    return { address: hostname, family: isIP(hostname) };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve ${hostname}`, hostname);
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`No addresses for ${hostname}`, hostname);
  }

  // Every answer must be public. If a name resolves to a mix, treat the whole
  // name as hostile rather than cherry-picking.
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new SsrfBlockedError(
        `${hostname} resolves to a non-public address`,
        hostname,
      );
    }
  }

  return addresses[0]!;
}

/**
 * Builds a dispatcher pinned to one already-validated IP. `servername` keeps
 * TLS verification against the original hostname, so certificate validation
 * still applies.
 */
function pinnedAgent(hostname: string, address: string, family: number): Dispatcher {
  return new Agent({
    connect: {
      servername: hostname,
      lookup: (_host, _opts, callback) => {
        callback(null, address, family === 6 ? 6 : 4);
      },
    },
    headersTimeout: DEFAULTS.timeoutMs,
    bodyTimeout: DEFAULTS.timeoutMs,
  });
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Malformed URL', rawUrl);
  }

  let method = options.method ?? 'GET';
  let body = options.body;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    assertHttps(currentUrl);
    assertHostAllowed(currentUrl, options.allowedHosts);

    if (currentUrl.username || currentUrl.password) {
      throw new SsrfBlockedError('Credentials in URL are not permitted', currentUrl.toString());
    }

    const resolved = await resolvePublicAddress(currentUrl.hostname);
    const agent = pinnedAgent(currentUrl.hostname, resolved.address, resolved.family);

    try {
      const response = await undiciRequest(currentUrl, {
        method,
        headers: {
          'user-agent': 'ArmaServerPanel/1.0',
          accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
          ...options.headers,
        },
        body,
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        // Redirects are followed manually below so each hop is re-validated.
      });

      const location = response.headers.location;
      const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && location;

      if (isRedirect) {
        response.body.destroy();
        if (hop === maxRedirects) {
          throw new SsrfBlockedError('Too many redirects', currentUrl.toString());
        }
        const next = Array.isArray(location) ? location[0]! : location;
        currentUrl = new URL(next, currentUrl);
        // 303, and 301/302 in practice, downgrade to GET without a body.
        if (response.statusCode === 303 || response.statusCode === 301 || response.statusCode === 302) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      // Read with a hard byte cap so a hostile endpoint cannot exhaust memory.
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          response.body.destroy();
          throw new SsrfBlockedError('Response exceeded size limit', currentUrl.toString());
        }
        chunks.push(buf);
      }

      return {
        status: response.statusCode,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      };
    } finally {
      await agent.close().catch(() => undefined);
    }
  }

  throw new SsrfBlockedError('Too many redirects', currentUrl.toString());
}

/** Validates a user-supplied URL without sending anything. */
export async function assertUrlIsSafe(
  rawUrl: string,
  allowedHosts?: readonly string[],
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Malformed URL', rawUrl);
  }
  assertHttps(url);
  assertHostAllowed(url, allowedHosts);
  await resolvePublicAddress(url.hostname);
  logger.debug({ host: url.hostname }, 'Outbound URL validated');
}

export const DISCORD_WEBHOOK_HOSTS = ['discord.com', 'discordapp.com'] as const;
export const PUSHOVER_HOSTS = ['api.pushover.net'] as const;
export const AI_PROVIDER_HOSTS = ['api.anthropic.com', 'api.openai.com'] as const;
