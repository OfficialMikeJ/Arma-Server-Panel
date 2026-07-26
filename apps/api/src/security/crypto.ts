/**
 * Cryptographic primitives.
 *
 * Every secret the panel stores on behalf of a user (TOTP seeds, RCON
 * passwords, webhook URLs, third-party API keys, Docker TLS bundles) goes
 * through `encryptSecret`. Nothing sensitive is ever written as plaintext.
 *
 * Envelope layout (single Buffer):
 *   [0]      version   (1 byte)  - supports key rotation
 *   [1..12]  iv        (12 bytes) - random per message, never reused
 *   [13..28] authTag   (16 bytes)
 *   [29..]   ciphertext
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { loadConfig } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

const VERSION_CURRENT = 1;
const VERSION_PREVIOUS = 0;

/**
 * Additional authenticated data binds a ciphertext to its purpose, so an
 * envelope lifted from `accounts.totpSecretEnc` cannot be replayed into
 * `ai_providers.apiKeyEnc`.
 */
export type SecretContext =
  | 'totp'
  | 'discord-refresh'
  | 'server-secrets'
  | 'integration'
  | 'ai-key'
  | 'docker-tls'
  | 'challenge-payload';

function keyFor(version: number): Buffer {
  const config = loadConfig();
  if (version === VERSION_CURRENT) return config.encryptionKey;
  if (version === VERSION_PREVIOUS && config.encryptionKeyPrevious) {
    return config.encryptionKeyPrevious;
  }
  throw new Error(`No encryption key available for envelope version ${version}`);
}

/**
 * Returns a plain `Uint8Array` rather than a `Buffer` so the value drops
 * straight into Prisma `Bytes` columns without a cast at every call site.
 */
export function encryptSecret(
  plaintext: string | Buffer | Uint8Array,
  context: SecretContext,
): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyFor(VERSION_CURRENT), iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.concat([Buffer.from([VERSION_CURRENT]), iv, tag, ciphertext]);
  return toStandaloneBytes(envelope);
}

/** Copies into a dedicated ArrayBuffer so the type is `Uint8Array<ArrayBuffer>`. */
function toStandaloneBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  out.set(buffer);
  return out;
}

export function decryptSecret(envelope: Buffer | Uint8Array, context: SecretContext): Buffer {
  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (buf.length < HEADER_LENGTH) {
    throw new Error('Malformed secret envelope');
  }

  const version = buf[0]!;
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = buf.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyFor(version), iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);

  // Throws if the tag does not verify - which is exactly what we want.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decryptSecretToString(envelope: Buffer | Uint8Array, context: SecretContext): string {
  return decryptSecret(envelope, context).toString('utf8');
}

/** True when the envelope was written with a superseded key and should be re-wrapped. */
export function needsRewrap(envelope: Buffer | Uint8Array): boolean {
  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  return buf.length > 0 && buf[0] !== VERSION_CURRENT;
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/** SHA-256 hex digest. Used for opaque token lookups, never for passwords. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Keyed hash of a value that is sensitive but must remain searchable, such as
 * a client IP address. The pepper means a database leak does not let an
 * attacker enumerate addresses with a rainbow table.
 */
export function pepperedHash(value: string, domain: string): string {
  const { hashPepper } = loadConfig();
  return createHmac('sha256', hashPepper).update(`${domain}:${value}`).digest('hex');
}

/** Constant-time comparison that tolerates differing lengths without leaking. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  // Hash both sides first so length differences do not short-circuit and the
  // comparison is always over 32 bytes.
  const digestA = createHash('sha256').update(bufA).digest();
  const digestB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(digestA, digestB);
}

/* ------------------------------------------------------------------ */
/* Token generation                                                    */
/* ------------------------------------------------------------------ */

/** URL-safe random token. 32 bytes => 256 bits of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Crockford-style base32 alphabet, no ambiguous characters. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** Random integer in [0, max) without modulo bias. */
export function secureRandomInt(max: number): number {
  if (max <= 0 || max > 2 ** 31) throw new RangeError('max out of range');
  const limit = Math.floor(2 ** 32 / max) * max;
  for (;;) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < limit) return value % max;
  }
}

export { randomBytes };
