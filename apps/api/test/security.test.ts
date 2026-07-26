/**
 * Security unit tests.
 *
 * These cover the properties that are easy to break silently during a refactor
 * and expensive to discover in production: TOTP replay, username screening
 * bypasses, path traversal, and console sanitisation.
 *
 * Run with:  npm test -w @asp/api
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

// The config module fails closed, so give it valid values before anything
// imports it transitively.
process.env.NODE_ENV = 'test';
process.env.PUBLIC_APP_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test@localhost:5432/test';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.HASH_PEPPER = randomBytes(32).toString('hex');

const { checkUsername, normalizeForScreening, canonicalizeUsername, sanitizeConsoleText } =
  await import('@asp/shared');
const { generateTotpSecret, verifyTotp, currentStep } = await import('../src/security/totp.js');
const { encryptSecret, decryptSecretToString, base32Decode, safeEqual } = await import(
  '../src/security/crypto.js'
);
const { createPinnedLookup } = await import('../src/security/pinned-lookup.js');
const { resolveWithin } = await import('../src/modules/files/file-service.js');
const { redact, parseAssistantResponse } = await import('../src/modules/ai/ai-assistant.js');

/* ------------------------------------------------------------------ */

describe('TOTP', () => {
  it('accepts a correct code', () => {
    const secret = generateTotpSecret();
    const raw = base32Decode(secret.base32);
    const code = generateCodeFor(raw);
    const result = verifyTotp(raw, code, null);
    assert.equal(result.valid, true);
  });

  it('refuses a replayed code', () => {
    const secret = generateTotpSecret();
    const raw = base32Decode(secret.base32);
    const code = generateCodeFor(raw);

    const first = verifyTotp(raw, code, null);
    assert.equal(first.valid, true);

    // Same code, same step, now that the step has been recorded.
    const second = verifyTotp(raw, code, first.step);
    assert.equal(second.valid, false, 'a code must not be usable twice');
    assert.equal(second.reason, 'replayed');
  });

  it('rejects a malformed code without touching the secret', () => {
    const raw = base32Decode(generateTotpSecret().base32);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56x']) {
      assert.equal(verifyTotp(raw, bad, null).valid, false, `"${bad}" should be rejected`);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Username screening', () => {
  it('accepts a reasonable username', () => {
    assert.equal(checkUsername('Bacon_Man').ok, true);
    assert.equal(checkUsername('sgt-reyes').ok, true);
  });

  it('rejects reserved names', () => {
    for (const name of ['admin', 'Administrator', 'support', 'root']) {
      const result = checkUsername(name);
      assert.equal(result.ok, false, `"${name}" should be reserved`);
      assert.equal(result.reason, 'reserved');
    }
  });

  it('sees through leetspeak substitution', () => {
    // The whole point of normalising before matching.
    assert.equal(normalizeForScreening('Sh1tl0rd'), normalizeForScreening('shitlord'));
    assert.equal(normalizeForScreening('fuuuuuck'), 'fuck');
    assert.equal(normalizeForScreening('f.u.c.k'), 'fuck');
  });

  it('rejects Cyrillic homoglyph mixing', () => {
    // "аdmin" with a Cyrillic а.
    const result = checkUsername('\u0430dmin');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'confusable');
  });

  it('canonicalises separators so look-alikes collide', () => {
    assert.equal(canonicalizeUsername('Bacon_Man'), 'baconman');
    assert.equal(canonicalizeUsername('bacon-man'), 'baconman');
    assert.equal(canonicalizeUsername('BACONMAN'), 'baconman');
  });

  it('enforces length and character rules', () => {
    assert.equal(checkUsername('ab').reason, 'too_short');
    assert.equal(checkUsername('a'.repeat(25)).reason, 'too_long');
    assert.equal(checkUsername('has space').reason, 'invalid_characters');
    assert.equal(checkUsername('_leading').reason, 'starts_or_ends_with_separator');
    assert.equal(checkUsername('double__under').reason, 'consecutive_separators');
  });
});

/* ------------------------------------------------------------------ */

describe('Secret envelopes', () => {
  it('round-trips', () => {
    const envelope = encryptSecret('hunter2', 'totp');
    assert.equal(decryptSecretToString(envelope, 'totp'), 'hunter2');
  });

  it('refuses to decrypt under a different purpose', () => {
    // AAD binding: an envelope from one column must not be replayable into
    // another.
    const envelope = encryptSecret('hunter2', 'totp');
    assert.throws(() => decryptSecretToString(envelope, 'ai-key'));
  });

  it('produces a different ciphertext each time', () => {
    const a = Buffer.from(encryptSecret('same', 'totp'));
    const b = Buffer.from(encryptSecret('same', 'totp'));
    assert.notEqual(a.toString('hex'), b.toString('hex'), 'IV must never repeat');
  });

  it('detects tampering', () => {
    const envelope = Buffer.from(encryptSecret('hunter2', 'totp'));
    envelope[envelope.length - 1] ^= 0xff;
    assert.throws(() => decryptSecretToString(envelope, 'totp'));
  });
});

describe('Constant-time comparison', () => {
  it('matches identical values and rejects others', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcdef'), false);
    assert.equal(safeEqual('', ''), true);
  });
});

/* ------------------------------------------------------------------ */

describe('Pinned DNS lookup', () => {
  it('returns an array when the caller asks for all addresses', () => {
    // undici calls the custom lookup with { all: true } and reads
    // addresses[0].address. Returning a bare string here is what produced
    // "Invalid IP address: undefined" and broke every outbound request.
    const lookup = createPinnedLookup({ address: '203.0.113.10', family: 4 });

    let received: unknown;
    lookup('example.com', { all: true }, (_error, value) => {
      received = value;
    });

    assert.ok(Array.isArray(received), 'must hand back an array when all:true');
    assert.deepEqual(received, [{ address: '203.0.113.10', family: 4 }]);
  });

  it('returns the legacy (address, family) form otherwise', () => {
    const lookup = createPinnedLookup({ address: '203.0.113.10', family: 4 });

    let address: unknown;
    let family: unknown;
    lookup('example.com', {}, (_error, value, fam) => {
      address = value;
      family = fam;
    });

    assert.equal(address, '203.0.113.10');
    assert.equal(family, 4);
  });

  it('normalises the address family to 4 or 6', () => {
    const lookup = createPinnedLookup({ address: '::1', family: 6 });
    let received: Array<{ family: number }> = [];
    lookup('example.com', { all: true }, (_error, value) => {
      received = value as Array<{ family: number }>;
    });
    assert.equal(received[0]?.family, 6);
  });
});

/* ------------------------------------------------------------------ */

describe('Path confinement', () => {
  const root = process.platform === 'win32' ? 'C:\\srv\\asp\\server1' : '/srv/asp/server1';

  it('allows paths inside the root', async () => {
    const resolved = await resolveWithin(root, 'config/server.cfg');
    assert.ok(resolved.includes('server1'));
  });

  it('rejects traversal', async () => {
    for (const attempt of ['../other', '../../etc/passwd', 'config/../../escape']) {
      await assert.rejects(
        () => resolveWithin(root, attempt),
        undefined,
        `"${attempt}" must be rejected`,
      );
    }
  });

  it('rejects a null byte', async () => {
    await assert.rejects(() => resolveWithin(root, 'config\0.cfg'));
  });
});

/* ------------------------------------------------------------------ */

describe('Console sanitisation', () => {
  it('strips ANSI escape sequences', () => {
    const input = '\u001b[31mred\u001b[0m text';
    assert.equal(sanitizeConsoleText(input), 'red text');
  });

  it('strips control characters but keeps newlines and tabs', () => {
    assert.equal(sanitizeConsoleText('a\u0000b\u0007c'), 'abc');
    assert.equal(sanitizeConsoleText('a\tb\nc'), 'a\tb\nc');
  });

  it('caps length', () => {
    assert.equal(sanitizeConsoleText('x'.repeat(100), 10).length, 10);
  });
});

/* ------------------------------------------------------------------ */

describe('AI redaction', () => {
  it('removes credentials from config text', () => {
    const input = 'passwordAdmin = "s3cret"; serverCommandPassword = "rcon123";';
    const output = redact(input);
    assert.ok(!output.includes('s3cret'), 'admin password must be redacted');
    assert.ok(!output.includes('rcon123'), 'rcon password must be redacted');
  });

  it('removes API keys and webhook URLs', () => {
    const input =
      'key sk-ant-abcdefghijklmnop and https://discord.com/api/webhooks/123/abcdefgh';
    const output = redact(input);
    assert.ok(!output.includes('sk-ant-abcdefghijklmnop'));
    assert.ok(!output.includes('/webhooks/123/'));
  });

  it('removes IP addresses', () => {
    assert.ok(!redact('connect 203.0.113.42:2302').includes('203.0.113.42'));
  });
});

describe('AI response parsing', () => {
  it('extracts JSON from a fenced block', () => {
    const parsed = parseAssistantResponse(
      'Here you go:\n```json\n{"summary":"ok","diagnosis":"d","actions":[]}\n```',
    );
    assert.equal(parsed.summary, 'ok');
  });

  it('discards actions outside the allowlist', () => {
    const parsed = parseAssistantResponse(
      JSON.stringify({
        summary: 's',
        actions: [{ kind: 'rm_rf_host', rationale: 'no', parameters: {}, risk: 'low' }],
      }),
    );
    assert.equal(parsed.actions.length, 0, 'an invented action kind must not survive');
  });

  it('degrades to a summary when the model returns prose', () => {
    const parsed = parseAssistantResponse('The server ran out of memory.');
    assert.ok(parsed.summary.includes('out of memory'));
    assert.equal(parsed.actions.length, 0);
  });
});

/* ------------------------------------------------------------------ */

function generateCodeFor(secret: Buffer, atMs = Date.now()): string {
  // Mirrors the implementation so the test does not depend on a fixed clock.
  const step = currentStep(atMs);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** 6).toString().padStart(6, '0');
}
