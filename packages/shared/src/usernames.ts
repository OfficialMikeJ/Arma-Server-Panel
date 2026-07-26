/**
 * Username validation and acceptability screening.
 *
 * Screening runs against a *normalised* form of the input so that leetspeak,
 * padding characters, repeated letters and Unicode confusables cannot be used
 * to smuggle a blocked term past the filter.
 */

import { USERNAME_POLICY } from './constants.js';

export type UsernameRejectionReason =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'starts_or_ends_with_separator'
  | 'consecutive_separators'
  | 'reserved'
  | 'impersonation'
  | 'offensive'
  | 'confusable'
  | 'taken';

export interface UsernameCheckResult {
  ok: boolean;
  reason?: UsernameRejectionReason;
  message?: string;
  /** Canonical form used for uniqueness comparison. Prevents look-alike squatting. */
  canonical: string;
  /** Aggressively folded form used only for blocklist matching. */
  normalized: string;
}

/** Only ASCII letters, digits, underscore and hyphen. Deliberately narrow. */
const ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Names the platform reserves for itself. Registering these would let a user
 * impersonate staff or collide with a system route.
 */
const RESERVED = new Set<string>([
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'superuser', 'su',
  'owner', 'staff', 'support', 'helpdesk', 'moderator', 'mod', 'operator',
  'official', 'security', 'billing', 'payments', 'accounts', 'account',
  'api', 'apikey', 'www', 'ftp', 'mail', 'email', 'smtp', 'imap', 'ns',
  'panel', 'armaserverpanel', 'asp', 'server', 'servers', 'node', 'nodes',
  'null', 'undefined', 'none', 'nil', 'true', 'false', 'test', 'guest',
  'anonymous', 'anon', 'nobody', 'everyone', 'here', 'all', 'me', 'self',
  'login', 'logout', 'register', 'signup', 'signin', 'auth', 'oauth',
  'settings', 'profile', 'dashboard', 'console', 'health', 'metrics',
  'webhook', 'webhooks', 'callback', 'discord', 'steam', 'bohemia',
  'bistudio', 'battleye', 'arma', 'reforger', 'claude', 'anthropic', 'openai',
]);

/**
 * Terms that make a username unacceptable. Matched as substrings against the
 * normalised form, so `bad` also catches `b.a.d`, `BAAAD` and `8ad`.
 *
 * This is intentionally conservative: false positives are recoverable (the user
 * picks another name), false negatives are not.
 */
const OFFENSIVE_FRAGMENTS: string[] = [
  // sexual / explicit
  'anal', 'anus', 'blowjob', 'boner', 'buttplug', 'clit', 'cock', 'cum',
  'cunt', 'deepthroat', 'dick', 'dildo', 'ejaculate', 'erection', 'fellatio',
  'fuck', 'handjob', 'hentai', 'horny', 'incest', 'jizz', 'masturbat',
  'milf', 'orgasm', 'penis', 'porn', 'pussy', 'rimjob', 'semen', 'sex',
  'slut', 'sperm', 'testicle', 'titties', 'twat', 'vagina', 'whore',
  // child safety - zero tolerance
  'childporn', 'cp', 'jailbait', 'loli', 'pedo', 'pedophile', 'shota',
  // violence / self harm
  'genocide', 'holocaust', 'killyourself', 'kys', 'lynch', 'massacre',
  'murder', 'rape', 'rapist', 'schoolshoot', 'shooter', 'suicide', 'terrorist',
  // hate / harassment
  'chink', 'coon', 'dyke', 'fag', 'faggot', 'gook', 'kike', 'nazi',
  'nigg', 'paki', 'raghead', 'retard', 'spic', 'tranny', 'wetback',
  'whitepower', 'heilhitler', 'hitler', 'kkk', '1488', 'sieg heil',
  // scatological / general profanity
  'arsehole', 'asshole', 'bastard', 'bitch', 'bollock', 'bullshit',
  'crap', 'damn', 'dumbass', 'goddamn', 'jackass', 'motherfucker',
  'piss', 'prick', 'shit', 'wanker',
  // scam / impersonation bait
  'freenitro', 'giveaway', 'freerobux', 'creditcard', 'ssn',
];

/** Substrings that imply the account speaks for the platform. */
const IMPERSONATION_FRAGMENTS: string[] = [
  'armaserverpanel', 'aspsupport', 'aspstaff', 'aspadmin', 'panelstaff',
  'panelsupport', 'paneladmin', 'officialsupport', 'officialstaff',
  'discordstaff', 'steamsupport', 'bohemiastaff',
];

/**
 * Fragments that are only offensive when they make up the whole name, so they
 * are checked with equality rather than containment. Keeps `Scunthorpe`-class
 * false positives down.
 */
const OFFENSIVE_EXACT = new Set<string>(['ass', 'hell', 'sex', 'cp', 'kys']);

/** Leetspeak / homoglyph folding used before blocklist matching. */
const FOLD_MAP: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's',
  '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '<': 'c',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ʏ': 'y',
};

/**
 * Canonical form: what uniqueness is checked against.
 * `Bacon_Man`, `bacon-man` and `BaconMan` all canonicalise to `baconman`,
 * which stops visually-identical account squatting.
 */
export function canonicalizeUsername(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_-]/g, '');
}

/** Aggressive fold used only for offensive-term matching. */
export function normalizeForScreening(input: string): string {
  const decomposed = input.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
  let out = '';
  for (const ch of decomposed.toLowerCase()) {
    const folded = FOLD_MAP[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    if (/[a-z]/.test(ch)) out += ch;
    // every other character (digits already folded, punctuation, spaces) is dropped
  }
  // Collapse runs of *three or more* to a single character: "fuuuuck" -> "fuck".
  // Genuine doubled letters are left alone, because collapsing them turns
  // innocent words into slurs - "bacon" would match the fragment "coon" once
  // both sides are squashed to "con".
  return out.replace(/(.)\1{2,}/g, '$1');
}

/** Every run of repeats squashed. Used only for needles that have no doubles. */
function fullyCollapse(value: string): string {
  return value.replace(/(.)\1+/g, '$1');
}

/** True when the string mixes scripts in a way typical of homoglyph attacks. */
function hasSuspiciousScriptMix(input: string): boolean {
  const hasLatin = /[A-Za-z]/.test(input);
  const hasNonLatinLetter = /[^\x00-\x7F]/.test(input);
  return hasLatin && hasNonLatinLetter;
}

export function checkUsername(raw: string): UsernameCheckResult {
  const input = raw.normalize('NFKC').trim();
  const canonical = canonicalizeUsername(input);
  const normalized = normalizeForScreening(input);
  const base = { canonical, normalized };

  if (hasSuspiciousScriptMix(input)) {
    return {
      ok: false,
      reason: 'confusable',
      message: 'Username mixes character sets in a way that is not permitted. Use A-Z, 0-9, underscore or hyphen.',
      ...base,
    };
  }

  if (input.length < USERNAME_POLICY.minLength) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Username must be at least ${USERNAME_POLICY.minLength} characters.`,
      ...base,
    };
  }

  if (input.length > USERNAME_POLICY.maxLength) {
    return {
      ok: false,
      reason: 'too_long',
      message: `Username must be at most ${USERNAME_POLICY.maxLength} characters.`,
      ...base,
    };
  }

  if (!ALLOWED_PATTERN.test(input)) {
    return {
      ok: false,
      reason: 'invalid_characters',
      message: 'Username may only contain letters, numbers, underscore and hyphen.',
      ...base,
    };
  }

  if (/^[_-]|[_-]$/.test(input)) {
    return {
      ok: false,
      reason: 'starts_or_ends_with_separator',
      message: 'Username cannot start or end with an underscore or hyphen.',
      ...base,
    };
  }

  if (/[_-]{2,}/.test(input)) {
    return {
      ok: false,
      reason: 'consecutive_separators',
      message: 'Username cannot contain two separators in a row.',
      ...base,
    };
  }

  if (RESERVED.has(canonical) || RESERVED.has(normalized)) {
    return {
      ok: false,
      reason: 'reserved',
      message: 'That username is reserved.',
      ...base,
    };
  }

  for (const fragment of IMPERSONATION_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      return {
        ok: false,
        reason: 'impersonation',
        message: 'That username could be mistaken for platform staff.',
        ...base,
      };
    }
  }

  if (OFFENSIVE_EXACT.has(normalized)) {
    return {
      ok: false,
      reason: 'offensive',
      message: 'That username is not acceptable. Please choose another.',
      ...base,
    };
  }

  const collapsed = fullyCollapse(normalized);

  for (const fragment of OFFENSIVE_FRAGMENTS) {
    const needle = fragment.replace(/[^a-z]/g, '');
    if (needle.length < 3) continue;

    // Direct match against the lightly-normalised form.
    let hit = normalized.includes(needle);

    // A needle with no doubled letters can also be matched against the fully
    // squashed form, which catches padding like "fuuuck". Needles that *do*
    // contain doubles (coon, kkk) are excluded here, since squashing them
    // would produce false positives on ordinary words.
    if (!hit && needle === fullyCollapse(needle)) {
      hit = collapsed.includes(needle);
    }

    if (hit) {
      return {
        ok: false,
        reason: 'offensive',
        message: 'That username is not acceptable. Please choose another.',
        ...base,
      };
    }
  }

  return { ok: true, ...base };
}

/** Reasons that count as "unacceptable" for the warn-then-ban policy. */
export const ABUSIVE_REJECTION_REASONS: ReadonlySet<UsernameRejectionReason> = new Set([
  'offensive',
  'impersonation',
  'confusable',
]);

export function isAbusiveRejection(reason: UsernameRejectionReason | undefined): boolean {
  return reason !== undefined && ABUSIVE_REJECTION_REASONS.has(reason);
}
