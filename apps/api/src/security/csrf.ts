/**
 * CSRF defence, in three independent layers.
 *
 *   1. SameSite=Strict on the session cookie - stops the browser attaching it
 *      to cross-site requests at all.
 *   2. Origin / Sec-Fetch-Site verification - rejects anything that did not
 *      originate from our own page.
 *   3. Double-submit token - the header value must match the digest bound to
 *      the session, which an attacker cannot read cross-origin.
 *
 * Any one of these would usually be enough. All three are applied because
 * layer 1 has historically been bypassed by browser bugs and layer 2 by
 * requests that omit Origin entirely.
 */

import type { FastifyRequest } from 'fastify';
import { SESSION } from '@asp/shared';
import { loadConfig } from '../config/env.js';
import { safeEqual, sha256Hex } from './crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfFailure =
  | 'origin_missing'
  | 'origin_mismatch'
  | 'cross_site_fetch'
  | 'token_missing'
  | 'token_mismatch';

export interface CsrfResult {
  ok: boolean;
  reason?: CsrfFailure;
}

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Layer 2. Runs on every state-changing request, session or not. */
export function verifyRequestOrigin(request: FastifyRequest): CsrfResult {
  if (isSafeMethod(request.method)) return { ok: true };

  const config = loadConfig();
  const allowedOrigins = new Set([config.appOrigin, config.apiOrigin]);

  // Modern browsers send this and it cannot be forged by page script.
  const fetchSite = headerValue(request, 'sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return { ok: false, reason: 'cross_site_fetch' };
  }

  const origin = headerValue(request, 'origin');
  if (origin && origin !== 'null') {
    return allowedOrigins.has(origin) ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
  }

  // No Origin: fall back to Referer.
  const referer = headerValue(request, 'referer');
  if (referer) {
    try {
      return allowedOrigins.has(new URL(referer).origin)
        ? { ok: true }
        : { ok: false, reason: 'origin_mismatch' };
    } catch {
      return { ok: false, reason: 'origin_mismatch' };
    }
  }

  // Neither header present. `sec-fetch-site: none` means a direct navigation,
  // which cannot be a cross-site form post, so it is allowed through.
  if (fetchSite === 'none') return { ok: true };

  return { ok: false, reason: 'origin_missing' };
}

/** Layer 3. Only meaningful for cookie-authenticated requests. */
export function verifyCsrfToken(
  request: FastifyRequest,
  sessionCsrfHash: string,
): CsrfResult {
  if (isSafeMethod(request.method)) return { ok: true };

  const cookies = request.cookies as Record<string, string | undefined>;
  const header = headerValue(request, SESSION.csrfHeaderName);
  // Accept either name: the __Host- prefixed cookie is used over TLS, the
  // unprefixed one over plain HTTP where browsers reject the prefix.
  const cookie = cookies[SESSION.csrfCookieName] ?? cookies[SESSION.insecureCsrfCookieName];

  if (!header || !cookie) return { ok: false, reason: 'token_missing' };

  // The header must match the cookie (double submit) *and* the digest recorded
  // on the session (so a cookie planted by a subdomain is useless).
  if (!safeEqual(header, cookie)) return { ok: false, reason: 'token_mismatch' };
  if (!safeEqual(sha256Hex(header), sessionCsrfHash)) return { ok: false, reason: 'token_mismatch' };

  return { ok: true };
}

export const CSRF_FAILURE_MESSAGES: Record<CsrfFailure, string> = {
  origin_missing: 'Request origin could not be verified.',
  origin_mismatch: 'Request origin is not permitted.',
  cross_site_fetch: 'Cross-site requests are not permitted.',
  token_missing: 'CSRF token missing.',
  token_mismatch: 'CSRF token is invalid.',
};
