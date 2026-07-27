/**
 * Steam credentials for downloading paid dedicated-server packages.
 *
 * Arma 3's server package is not free, so SteamCMD needs an account that owns
 * the game. Reforger's is free and needs none.
 *
 * On storage, and why the UI says what it says:
 *
 * The password is AES-256-GCM encrypted with the same envelope as every other
 * stored credential, so a stolen database dump or backup does not yield it.
 * But it is *reversible by necessity* - SteamCMD is handed the real password on
 * every install, so this can never be a one-way hash the way an account
 * password is. Anyone holding both the database and ENCRYPTION_KEY recovers it.
 *
 * That is a meaningfully weaker guarantee than the panel makes anywhere else,
 * and the honest conclusion is the one the notice draws: use a throwaway
 * account that owns Arma 3 and nothing else.
 */

import { loadConfig } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { decryptSecretToString, encryptSecret } from '../../security/crypto.js';
import { getPlatformSettings } from './platform-settings.js';

export interface SteamCredentials {
  username: string;
  password: string;
}

export interface SteamCredentialStatus {
  configured: boolean;
  username: string | null;
  /** True when the values come from .env rather than the panel's own store. */
  fromEnvironment: boolean;
  setAt: string | null;
}

/**
 * The credentials to hand SteamCMD.
 *
 * What the operator saved in the panel wins; the environment remains a
 * fallback so an existing install keeps working without being re-entered, and
 * so an air-gapped deployment can still supply them by file.
 */
export async function getSteamCredentials(): Promise<SteamCredentials | null> {
  const settings = await getPlatformSettings();

  if (settings.steamUsername && settings.steamPasswordEnc) {
    try {
      return {
        username: settings.steamUsername,
        password: decryptSecretToString(settings.steamPasswordEnc, 'steam-credentials'),
      };
    } catch (error) {
      // A key rotation that missed this envelope should not silently fall back
      // to a stale environment value - say so instead.
      logger.error({ err: error }, 'Stored Steam password could not be decrypted');
      return null;
    }
  }

  const config = loadConfig();
  if (config.STEAM_USERNAME && config.STEAM_PASSWORD) {
    return { username: config.STEAM_USERNAME, password: config.STEAM_PASSWORD };
  }

  return null;
}

/** What the settings screen shows. Never includes the password. */
export async function getSteamCredentialStatus(): Promise<SteamCredentialStatus> {
  const settings = await getPlatformSettings();

  if (settings.steamUsername && settings.steamPasswordEnc) {
    return {
      configured: true,
      username: settings.steamUsername,
      fromEnvironment: false,
      setAt: settings.steamCredentialsSetAt?.toISOString() ?? null,
    };
  }

  const config = loadConfig();
  if (config.STEAM_USERNAME && config.STEAM_PASSWORD) {
    return {
      configured: true,
      username: config.STEAM_USERNAME,
      fromEnvironment: true,
      setAt: null,
    };
  }

  return { configured: false, username: null, fromEnvironment: false, setAt: null };
}

export async function saveSteamCredentials(credentials: SteamCredentials): Promise<void> {
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      steamUsername: credentials.username,
      steamPasswordEnc: encryptSecret(credentials.password, 'steam-credentials'),
      steamCredentialsSetAt: new Date(),
    },
  });
}

export async function clearSteamCredentials(): Promise<void> {
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { steamUsername: null, steamPasswordEnc: null, steamCredentialsSetAt: null },
  });
}

/**
 * Steam Guard cannot be detected without attempting a login, so this reads the
 * failure back out of SteamCMD's own output.
 *
 * SteamCMD's wording has changed over the years and differs between the code
 * being emailed and the mobile authenticator, so several forms are matched.
 */
const STEAM_GUARD_PATTERNS = [
  /steam ?guard/i,
  /two-?factor/i,
  /account logon denied/i,
  /needs? (?:a |an )?(?:two-factor|2fa|mobile) ?(?:authenticator|code)/i,
  /invalid ?(?:auth|login) ?code/i,
];

export function looksLikeSteamGuardFailure(output: string): boolean {
  return STEAM_GUARD_PATTERNS.some((pattern) => pattern.test(output));
}

/** Wrong username or password, as opposed to a second-factor prompt. */
const BAD_CREDENTIAL_PATTERNS = [
  /invalid ?password/i,
  /login failure/i,
  /account ?(?:name|login) ?not ?found/i,
  /rate ?limit ?exceeded/i,
];

export function looksLikeBadSteamCredentials(output: string): boolean {
  return BAD_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Turns a SteamCMD failure into something an operator can act on.
 *
 * Returns null when the output does not look like a login problem, so a
 * genuine download error is not mislabelled as one.
 */
export function explainSteamFailure(output: string): string | null {
  if (looksLikeSteamGuardFailure(output)) {
    return (
      'Steam refused the login because Steam Guard is enabled on that account. ' +
      'SteamCMD cannot answer a Steam Guard prompt, so the download cannot proceed. ' +
      'Turn Steam Guard off on the throwaway account used here, wait for Steam to ' +
      'apply the change, then reinstall.'
    );
  }
  if (looksLikeBadSteamCredentials(output)) {
    return (
      'Steam rejected the username or password. Check them under Administration, ' +
      'and note that Steam rate-limits repeated failures for a while after several ' +
      'wrong attempts.'
    );
  }
  return null;
}
