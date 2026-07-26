/**
 * API client.
 *
 * Two rules that matter for security:
 *   1. `credentials: 'include'` plus the CSRF header on every mutating call.
 *      The CSRF value is read from a cookie the server sets non-HttpOnly for
 *      exactly this purpose.
 *   2. Errors are normalised into `ApiError` so components never render a raw
 *      response body.
 */

import { SESSION, type ApiErrorBody } from '@asp/shared';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${encodeURIComponent(name)}=`));
  return match ? decodeURIComponent(match.slice(match.indexOf('=') + 1)) : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Set for endpoints that legitimately return 401 (e.g. session probe). */
  allowUnauthenticated?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  // Only state-changing verbs carry the double-submit token.
  if (method !== 'GET') {
    // __Host- prefixed over TLS, unprefixed over plain HTTP - the browser
    // rejects the prefixed form on an insecure origin.
    const csrf = readCookie(SESSION.csrfCookieName) ?? readCookie(SESSION.insecureCsrfCookieName);
    if (csrf) headers[SESSION.csrfHeaderName] = csrf;
  }

  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    // Never let a redirect carry credentials somewhere unexpected.
    redirect: 'error',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as (ApiErrorBody & { retryAfterSeconds?: number }) | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.details,
      body?.retryAfterSeconds ??
        (response.headers.get('retry-after')
          ? Number(response.headers.get('retry-after'))
          : undefined),
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};

/** WebSocket URL for the live console, derived from the API origin. */
export function consoleSocketUrl(serverId: string): string {
  const base = API_BASE.replace(/^http/, 'ws');
  return `${base}/api/v1/servers/${encodeURIComponent(serverId)}/console/stream`;
}

export { API_BASE };
