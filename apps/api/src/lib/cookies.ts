/**
 * Cookie helpers.
 *
 * Both cookies use the `__Host-` prefix, which the browser only accepts when
 * the cookie is Secure, has Path=/ and has no Domain attribute. That makes it
 * impossible for a sibling subdomain to overwrite them - the standard setup
 * for cookie-tossing attacks against double-submit CSRF.
 */

import type { FastifyReply } from 'fastify';
import { SESSION, TRUSTED_DEVICE, sessionCookieNames } from '@asp/shared';
import { loadConfig } from '../config/env.js';

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge?: number;
  signed?: boolean;
}

function baseOptions(maxAgeSeconds?: number): CookieOptions {
  const config = loadConfig();
  return {
    httpOnly: true,
    secure: config.REQUIRE_SECURE_COOKIES,
    sameSite: 'strict',
    path: '/',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

/** Cookie names appropriate to the current transport. */
export function cookieNames(): { session: string; csrf: string } {
  return sessionCookieNames(loadConfig().REQUIRE_SECURE_COOKIES);
}

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { token: string; csrfToken: string },
  elevated: boolean,
): void {
  const maxAge = Math.floor(
    (elevated ? SESSION.adminAbsoluteTimeoutMs : SESSION.absoluteTimeoutMs) / 1000,
  );
  const names = cookieNames();

  reply.setCookie(names.session, tokens.token, baseOptions(maxAge));

  // The CSRF cookie is deliberately readable by page script - that is how the
  // SPA echoes it back in the header. Its value is useless without the session
  // cookie, which script cannot read.
  reply.setCookie(names.csrf, tokens.csrfToken, {
    ...baseOptions(maxAge),
    httpOnly: false,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  const options = { ...baseOptions(0), maxAge: 0 };
  const names = cookieNames();
  reply.setCookie(names.session, '', options);
  reply.setCookie(names.csrf, '', { ...options, httpOnly: false });
}

/* ------------------------------------------------------------------ */
/* Trusted device                                                      */
/* ------------------------------------------------------------------ */

/** Same prefix rule as the session cookies: __Host- needs Secure. */
export function trustedDeviceCookieName(): string {
  return loadConfig().REQUIRE_SECURE_COOKIES
    ? TRUSTED_DEVICE.cookieName
    : TRUSTED_DEVICE.insecureCookieName;
}

export function setTrustedDeviceCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(trustedDeviceCookieName(), token, {
    ...baseOptions(Math.floor(TRUSTED_DEVICE.ttlMs / 1000)),
    // Outlives the session deliberately - that is the entire point.
    httpOnly: true,
  });
}

export function clearTrustedDeviceCookie(reply: FastifyReply): void {
  reply.setCookie(trustedDeviceCookieName(), '', { ...baseOptions(0), maxAge: 0 });
}

/** Reads whichever name is in play, so a transport change does not strand one. */
export function readTrustedDeviceCookie(
  cookies: Record<string, string | undefined>,
): string | undefined {
  return cookies[TRUSTED_DEVICE.cookieName] ?? cookies[TRUSTED_DEVICE.insecureCookieName];
}
