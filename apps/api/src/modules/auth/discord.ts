/**
 * Discord OAuth 2.0, authorization-code flow with PKCE.
 *
 * PKCE is not strictly required for a confidential client, but it costs
 * nothing and removes the whole class of authorization-code interception
 * attacks. The `state` value is bound to a server-side challenge rather than
 * held in a cookie, so a stolen state parameter is useless on its own.
 */

import { createHash } from 'node:crypto';
import { prisma } from '../../db/client.js';
import { loadConfig } from '../../config/env.js';
import { generateToken, encryptSecret } from '../../security/crypto.js';
import { safeFetch } from '../../security/ssrf.js';
import { issueChallenge, peekChallenge, consumeChallenge, CHALLENGE_TTL } from './challenges.js';
import { AppError, badRequest, serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_ME = 'https://discord.com/api/v10/users/@me';
const DISCORD_HOSTS = ['discord.com'] as const;

/** `identify` only. The panel never needs a user's email or guild list. */
const SCOPES = 'identify';

export interface DiscordAuthStart {
  url: string;
  /** Opaque token the client must present when completing the flow. */
  stateToken: string;
  expiresAt: Date;
}

interface StatePayload extends Record<string, unknown> {
  codeVerifier: string;
  /** Where to send the user afterwards. Always a path, never a full URL. */
  returnTo: string;
  intent: 'register' | 'login' | 'link';
  /** Bound to the browser so a leaked state cannot be redeemed elsewhere. */
  userAgentHash: string;
}

function redirectUri(): string {
  const config = loadConfig();
  return `${config.appOrigin}/auth/discord/callback`;
}

export function isDiscordEnabled(): boolean {
  return loadConfig().discordEnabled;
}

function assertEnabled(): void {
  if (!isDiscordEnabled()) {
    throw serviceUnavailable('Discord sign-in is not configured on this panel.');
  }
}

export async function startDiscordAuth(params: {
  intent: 'register' | 'login' | 'link';
  returnTo: string;
  userAgentHash: string;
  accountId?: string | null;
}): Promise<DiscordAuthStart> {
  assertEnabled();
  const config = loadConfig();

  const codeVerifier = generateToken(48);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  // Only same-origin paths are accepted as a return target, so the OAuth flow
  // cannot be turned into an open redirect.
  const safeReturnTo = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(params.returnTo)
    ? params.returnTo
    : '/panel';

  const challenge = await issueChallenge({
    kind: 'DISCORD_LINK',
    accountId: params.accountId ?? null,
    ttlMs: CHALLENGE_TTL.discordLink,
    maxAttempts: 3,
    payload: {
      codeVerifier,
      returnTo: safeReturnTo,
      intent: params.intent,
      userAgentHash: params.userAgentHash,
    } satisfies StatePayload,
  });

  const query = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    state: challenge.token,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });

  return {
    url: `${DISCORD_AUTHORIZE}?${query.toString()}`,
    stateToken: challenge.token,
    expiresAt: challenge.expiresAt,
  };
}

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

export interface DiscordCallbackResult {
  profile: DiscordProfile;
  intent: 'register' | 'login' | 'link';
  returnTo: string;
  accountId: string | null;
  /** Encrypted refresh token, ready to persist. Null when none was issued. */
  refreshTokenEnc: Uint8Array<ArrayBuffer> | null;
}

export async function completeDiscordAuth(params: {
  code: string;
  state: string;
  userAgentHash: string;
}): Promise<DiscordCallbackResult> {
  assertEnabled();
  const config = loadConfig();

  const lookup = await peekChallenge<StatePayload>(params.state, 'DISCORD_LINK');
  if (!lookup.ok || !lookup.challenge?.payload) {
    throw badRequest('This sign-in link has expired. Please start again.');
  }

  const payload = lookup.challenge.payload;

  // Binding the state to the browser that started the flow means an
  // intercepted callback URL cannot be replayed from another machine.
  if (payload.userAgentHash !== params.userAgentHash) {
    await consumeChallenge(lookup.challenge.id);
    throw badRequest('This sign-in link was started in a different browser.');
  }

  // Consume before the network call so a slow response cannot be raced.
  if (!(await consumeChallenge(lookup.challenge.id))) {
    throw badRequest('This sign-in link has already been used.');
  }

  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID!,
    client_secret: config.DISCORD_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri(),
    code_verifier: payload.codeVerifier,
  });

  const tokenResponse = await safeFetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    allowedHosts: DISCORD_HOSTS,
    timeoutMs: 10_000,
  });

  if (tokenResponse.status !== 200) {
    logger.warn({ status: tokenResponse.status }, 'Discord token exchange failed');
    throw new AppError(502, 'discord_exchange_failed', 'Could not complete Discord sign-in.');
  }

  let tokens: { access_token?: string; refresh_token?: string; token_type?: string };
  try {
    tokens = JSON.parse(tokenResponse.body);
  } catch {
    throw new AppError(502, 'discord_exchange_failed', 'Could not complete Discord sign-in.');
  }

  if (!tokens.access_token) {
    throw new AppError(502, 'discord_exchange_failed', 'Could not complete Discord sign-in.');
  }

  const meResponse = await safeFetch(DISCORD_ME, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    allowedHosts: DISCORD_HOSTS,
    timeoutMs: 10_000,
  });

  if (meResponse.status !== 200) {
    throw new AppError(502, 'discord_profile_failed', 'Could not read your Discord profile.');
  }

  let me: { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
  try {
    me = JSON.parse(meResponse.body);
  } catch {
    throw new AppError(502, 'discord_profile_failed', 'Could not read your Discord profile.');
  }

  if (!me.id || !/^\d{15,22}$/.test(me.id)) {
    throw new AppError(502, 'discord_profile_failed', 'Discord returned an unexpected profile.');
  }

  return {
    profile: {
      id: me.id,
      username: String(me.username ?? '').slice(0, 64),
      globalName: me.global_name ? String(me.global_name).slice(0, 64) : null,
      avatarUrl: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${encodeURIComponent(me.avatar)}.png?size=128`
        : null,
    },
    intent: payload.intent,
    returnTo: payload.returnTo,
    accountId: lookup.challenge.accountId,
    refreshTokenEnc: tokens.refresh_token
      ? encryptSecret(tokens.refresh_token, 'discord-refresh')
      : null,
  };
}

/** Looks up an existing account by Discord id. */
export async function findAccountByDiscordId(discordId: string) {
  return prisma.account.findFirst({
    where: { discordId, deletedAt: null },
  });
}
