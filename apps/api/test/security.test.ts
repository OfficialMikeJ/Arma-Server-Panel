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
const { serverNameSchema } = await import('@asp/shared');
const { createPinnedLookup } = await import('../src/security/pinned-lookup.js');
const { resolveWithin } = await import('../src/modules/files/file-service.js');
const { redact, parseAssistantResponse } = await import('../src/modules/ai/ai-assistant.js');
const { GAMES, PORT_ALLOCATION } = await import('@asp/shared');
const { renderServerCfg, renderBasicCfg, arma3Adapter } = await import(
  '../src/modules/games/adapters/arma3.js'
);
const { reforgerAdapter } = await import('../src/modules/games/adapters/reforger.js');
const { CONFIG_FIELDS, getConfigValue, setConfigValue, unmappedConfigKeys } = await import(
  '@asp/shared'
);
const { hasDirectPublicAddress } = await import('../src/modules/network/nat-traversal.js');
const { resetConfigForTests } = await import('../src/config/env.js');
const { confirmStaticForwards } = await import('../src/modules/network/port-forwarder.js');

/* ------------------------------------------------------------------ */

describe('Config field descriptors', () => {
  const adapters = { arma3: arma3Adapter, reforger: reforgerAdapter } as const;

  /**
   * Settings that stay JSON-only, and why. Anything not listed here must have a
   * form field, so adding a setting to an adapter without one fails the build.
   */
  const JSON_ONLY = new Set([
    // An array of {template, difficulty} objects - a repeater, not a control.
    'missions',
    // Free-form key/value pairs passed straight to the scenario.
    'missionHeader',
    // A fixed enum list where the sensible combinations are already covered by
    // the cross-platform toggle.
    'supportedPlatforms',
  ]);

  for (const [gameId, adapter] of Object.entries(adapters)) {
    const fields = CONFIG_FIELDS[gameId as 'arma3' | 'reforger'];
    const defaults = adapter.defaultConfig({ name: 'Test', slots: 32 }) as Record<string, unknown>;

    it(`${gameId}: every described field exists in the schema`, () => {
      for (const field of fields) {
        // adminPassword is optional on Reforger, so it is absent from the
        // defaults; its parent must still resolve.
        const [root] = field.key.split('.');
        assert.ok(
          root !== undefined && root in defaults,
          `${gameId} has a form field for "${field.key}" that its config does not contain`,
        );
      }
    });

    it(`${gameId}: describes every scalar the schema produces`, () => {
      const described = new Set(fields.map((f) => f.key));

      // Walks nested objects too. A setting added inside difficulty.* would
      // otherwise slip through: the form would not show it, and nothing would
      // say so. Arrays stop the walk - a list is described by one field, and
      // an array of objects is legitimately JSON-only.
      const missing: string[] = [];
      const walk = (value: unknown, prefix: string) => {
        if (Array.isArray(value)) {
          if (!described.has(prefix)) missing.push(prefix);
          return;
        }
        if (typeof value === 'object' && value !== null) {
          for (const [key, child] of Object.entries(value)) {
            walk(child, prefix ? `${prefix}.${key}` : key);
          }
          return;
        }
        if (!described.has(prefix)) missing.push(prefix);
      };
      walk(defaults, '');

      assert.deepEqual(
        missing.filter((key) => !JSON_ONLY.has(key)),
        [],
        `${gameId} config keys with no form field: ${missing.join(', ')}`,
      );
    });

    it(`${gameId}: select options cover the current value`, () => {
      for (const field of fields) {
        if (field.kind !== 'select') continue;
        const value = getConfigValue(defaults, field.key);
        if (value === undefined) continue;
        assert.ok(
          field.options.some((option) => option.value === value),
          `${gameId} field "${field.key}" defaults to ${JSON.stringify(value)}, which is not one of its options`,
        );
      }
    });

    it(`${gameId}: toggle values match what the schema stores`, () => {
      for (const field of fields) {
        if (field.kind !== 'toggle') continue;
        const value = getConfigValue(defaults, field.key);
        if (value === undefined) continue;
        assert.ok(
          value === field.trueValue || value === field.falseValue,
          `${gameId} field "${field.key}" defaults to ${JSON.stringify(value)}, which is neither of its toggle values`,
        );
      }
    });

    it(`${gameId}: a form round trip still validates`, () => {
      // Walk every field, write its current value straight back, and confirm
      // the adapter still accepts the result. Catches a descriptor whose path
      // is wrong: setConfigValue would create a new key instead of updating.
      let round: Record<string, unknown> = { ...defaults };
      for (const field of fields) {
        const value = getConfigValue(round, field.key);
        if (value === undefined) continue;
        round = setConfigValue(round, field.key, value);
      }
      assert.doesNotThrow(() => adapter.validateConfig(round, defaults));
      assert.deepEqual(round, defaults, 'a round trip through the form changed the config');
    });
  }

  it('reports keys the form does not cover', () => {
    const unmapped = unmappedConfigKeys(
      { hostname: 'x', missions: [], somethingNew: 1 },
      CONFIG_FIELDS.arma3,
    );
    assert.deepEqual(unmapped, ['missions', 'somethingNew']);
  });

  it('has no descriptors for an unreleased title', () => {
    assert.equal(CONFIG_FIELDS.arma4.length, 0);
  });
});

describe('Deployment detection', () => {
  // The panel is not only for home connections: a VPS, a dedicated box, a
  // colocated machine or a home lab on a routed prefix all hold a public
  // address themselves. Getting this wrong sends a data-centre operator off to
  // configure a router that does not exist.
  const cases: Array<[string, string, boolean]> = [
    ['a VPS', '5.161.42.17', true],
    ['a dedicated server', '65.108.200.3', true],
    ['a home LAN', '192.168.2.28', false],
    ['a 10.x home lab', '10.0.1.50', false],
    ['a 172.16 range', '172.20.5.9', false],
    ['CGNAT space', '100.64.3.1', false],
    ['link-local', '169.254.1.5', false],
    ['loopback', '127.0.0.1', false],
    // Documentation ranges are not routable either. Treating one as a public
    // host would skip NAT traversal on a machine that genuinely needs it, so
    // the conservative answer is the correct one.
    ['a documentation range', '203.0.113.10', false],
  ];

  for (const [label, address, expectPublic] of cases) {
    it(`${label} (${address}) is ${expectPublic ? '' : 'not '}a direct public host`, () => {
      const previous = process.env.LAN_ADDRESS;
      process.env.LAN_ADDRESS = address;
      resetConfigForTests();
      try {
        assert.equal(hasDirectPublicAddress(), expectPublic);
      } finally {
        if (previous === undefined) delete process.env.LAN_ADDRESS;
        else process.env.LAN_ADDRESS = previous;
        resetConfigForTests();
      }
    });
  }
});

describe('Static public address', () => {
  it('marks a node static when the operator states the address', () => {
    // Stating an address is the statement that it is fixed. Both the create and
    // update paths infer it, so an operator with a static IP does not have to
    // find a second checkbox before their manual forward stops being reported
    // as a failure.
    const inferred = (publicHost?: string, explicit?: boolean) =>
      explicit ?? Boolean(publicHost);

    assert.equal(inferred('203.0.113.5'), true);
    assert.equal(inferred('play.example.com'), true);
    assert.equal(inferred(undefined), false);
    // An explicit false still wins, for a dynamic address stated once.
    assert.equal(inferred('203.0.113.5', false), false);
  });

  const manualOutcomes = () =>
    [
      { portKey: 'game', externalPort: 2302, method: 'MANUAL', success: false, publicHost: null, message: 'Forward 2302/udp.' },
      { portKey: 'steamQuery', externalPort: 2303, method: 'MANUAL', success: false, publicHost: null, message: 'Forward 2303/udp.' },
    ] as never[];

  const staticNode = { state: 'RUNNING', node: { publicHost: '198.51.100.9', staticPublicHost: true } };

  it('confirms a hand-made forward instead of reporting failure', async () => {
    const outcomes = manualOutcomes();
    // The query port answers, which proves the block is forwarded.
    await confirmStaticForwards(staticNode, outcomes, async () => ({ name: 'TDE Survival' }));

    assert.ok(
      outcomes.every((o: { success: boolean }) => o.success),
      'a forward the panel can reach should not be reported as a failure',
    );
    assert.ok(
      outcomes.every((o: { publicHost: string | null }) => o.publicHost === '198.51.100.9'),
      'the confirmed address should be published',
    );
  });

  it('leaves it as a failure when nothing answers', async () => {
    const outcomes = manualOutcomes();
    await confirmStaticForwards(staticNode, outcomes, async () => null);
    assert.ok(outcomes.every((o: { success: boolean }) => !o.success));
  });

  it('does not claim success while the server is stopped', async () => {
    const outcomes = manualOutcomes();
    let probed = false;
    await confirmStaticForwards({ ...staticNode, state: 'OFFLINE' }, outcomes, async () => {
      probed = true;
      return { name: 'x' };
    });

    assert.equal(probed, false, 'a stopped server cannot answer, so it should not be probed');
    assert.ok(outcomes.every((o: { success: boolean }) => !o.success));
    assert.match(
      (outcomes[0] as { message: string }).message,
      /Start the server/,
      'it should say how to get the forward confirmed',
    );
  });

  it('does nothing for a node whose address is not fixed', async () => {
    const outcomes = manualOutcomes();
    let probed = false;
    await confirmStaticForwards(
      { state: 'RUNNING', node: { publicHost: '198.51.100.9', staticPublicHost: false } },
      outcomes,
      async () => {
        probed = true;
        return { name: 'x' };
      },
    );

    assert.equal(probed, false);
    assert.ok(outcomes.every((o: { success: boolean }) => !o.success));
  });
});

describe('Config path helpers', () => {
  it('reads and writes nested paths', () => {
    const source = { a: { b: { c: 1 } }, top: 'x' };
    assert.equal(getConfigValue(source, 'a.b.c'), 1);
    assert.equal(getConfigValue(source, 'a.b.missing'), undefined);
    assert.equal(getConfigValue(source, 'top.nope'), undefined);

    const next = setConfigValue(source, 'a.b.c', 2);
    assert.equal(next.a.b.c, 2);
    // The original must be untouched - React state depends on it.
    assert.equal(source.a.b.c, 1);
    assert.notEqual(next.a, source.a);
    assert.equal(next.top, 'x');
  });

  it('creates missing intermediate objects rather than throwing', () => {
    const next = setConfigValue({}, 'x.y.z', 5);
    assert.deepEqual(next, { x: { y: { z: 5 } } });
  });

  it('does not descend into an array as if it were an object', () => {
    const next = setConfigValue({ list: [1, 2] }, 'list.other', 3);
    assert.deepEqual(next, { list: { other: 3 } });
  });
});

/* ------------------------------------------------------------------ */

describe('Arma 3 server.cfg', () => {
  const defaults = arma3Adapter.defaultConfig({ name: 'Test Server', slots: 32 }) as never;
  const render = (overrides: Record<string, unknown> = {}) =>
    renderServerCfg({ ...(defaults as object), ...overrides } as never, {
      adminPassword: 'admin-secret',
      rconPassword: 'rcon-secret',
    });

  it('emits the parameters a stock config carries', () => {
    const cfg = render();
    for (const key of [
      'hostname', 'password', 'passwordAdmin', 'serverCommandPassword', 'logFile',
      'motd[]', 'motdInterval', 'maxPlayers', 'kickDuplicate', 'verifySignatures',
      'allowedFilePatching', 'loopback', 'upnp', 'admins[]', 'headlessClients[]',
      'localClient[]', 'voteMissionPlayers', 'voteThreshold', 'forceRotorLibSimulation',
      'disableVoN', 'vonCodec', 'vonCodecQuality', 'persistent', 'timeStampFormat',
      'BattlEye', 'drawingInMap', 'allowedLoadFileExtensions[]',
      'allowedPreprocessFileExtensions[]', 'allowedHTMLLoadExtensions[]',
      'disconnectTimeout', 'maxdesync', 'maxping', 'maxpacketloss', 'forcedDifficulty',
      'onUserConnected', 'onUserDisconnected', 'doubleIdDetected',
      'onUnsignedData', 'onHackedData', 'onDifferentData',
    ]) {
      assert.ok(cfg.includes(`${key} = `), `server.cfg is missing ${key}`);
    }
    assert.ok(cfg.includes('class Missions'));
    assert.ok(cfg.includes('class DifficultyPresets'));
    assert.ok(cfg.includes('class CustomAILevel'));
  });

  it('omits parameters Arma 3 does not read', () => {
    const cfg = render();
    // Operation Flashpoint leftovers, and Steam ports that Arma derives from
    // -port rather than reading from the config.
    for (const key of ['requiredSecureId', 'steamPort', 'steamQueryPort']) {
      assert.ok(!cfg.includes(key), `server.cfg should not carry ${key}`);
    }
  });

  it('never lets the game manage its own port forwarding', () => {
    assert.ok(render().includes('upnp = 0;'));
  });

  it('keeps a URL in the server name intact but neutralises quotes', () => {
    const cfg = render({
      hostname: 'TDE Survival NA #1 - https://discord.gg/ykkkjwDnAD For mod List',
    });
    assert.ok(cfg.includes('https://discord.gg/ykkkjwDnAD'));

    const injected = render({ hostname: 'evil"; passwordAdmin = "owned' });
    assert.ok(!/passwordAdmin = "owned/.test(injected));
    assert.ok(injected.includes('evil""; passwordAdmin = ""owned'));
  });

  it('balances every brace it opens', () => {
    const cfg = render({ missions: [{ template: 'MyMission.Altis', difficulty: 'regular' }] });
    const opens = (cfg.match(/\{/g) ?? []).length;
    const closes = (cfg.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, 'unbalanced braces would stop the server parsing its config');
    assert.ok(cfg.includes('template = "MyMission.Altis";'));
  });

  it('defaults file patching closed', () => {
    assert.ok(render().includes('allowedFilePatching = 0;'));
  });
});

describe('Arma 3 basic.cfg', () => {
  const defaults = arma3Adapter.defaultConfig({ name: 'Test', slots: 32 }) as never;

  it('emits the network tuning the game expects', () => {
    const cfg = renderBasicCfg(defaults);
    for (const key of [
      'MinBandwidth', 'MaxBandwidth', 'MaxMsgSend', 'MaxSizeGuaranteed',
      'MaxSizeNonguaranteed', 'MinErrorToSend', 'MinErrorToSendNear', 'MaxCustomFileSize',
    ]) {
      assert.match(cfg, new RegExp(`^${key}=[0-9.]+;$`, 'm'), `basic.cfg is missing ${key}`);
    }
  });

  it('does not leave the server on Arma’s 128 kbit default', () => {
    // MinBandwidth defaults to 131072 in the engine, which throttles anything
    // modern. Writing no basic.cfg at all - which the panel used to do - left
    // every server there.
    const config = arma3Adapter.defaultConfig({ name: 'Test', slots: 32 }) as {
      network: { minBandwidth: number };
    };
    assert.ok(config.network.minBandwidth > 131072);
  });

  it('blocks custom file uploads by default', () => {
    assert.match(renderBasicCfg(defaults), /^MaxCustomFileSize=0;$/m);
  });
});

/* ------------------------------------------------------------------ */

describe('Port allocation', () => {
  it('starts each released title on the port it conventionally uses', () => {
    // Arma 3's five ports are 2302-2306 and every one is derived from -port.
    assert.equal(GAMES.arma3.portBlock.base, 2302);
    // Reforger's stock game port.
    assert.equal(GAMES.reforger.portBlock.base, 2001);
  });

  it('spaces Arma 3 servers by at least 100, as Bohemia require', () => {
    // "Leave at least 100 ports between instances": 2302, 2402, 2502. Packing
    // them tightly produces Steam registration clashes that look like a broken
    // server rather than a port problem.
    assert.ok(GAMES.arma3.portBlock.stride >= 100);
  });

  it('gives every game a block wide enough for the ports it binds', () => {
    for (const game of Object.values(GAMES)) {
      const span = Math.max(...game.ports.map((p) => p.offset)) + 1;
      assert.ok(
        span <= game.portBlock.stride,
        `${game.name} needs ${span} ports but strides only ${game.portBlock.stride}`,
      );
      assert.ok(
        game.portBlock.base >= PORT_ALLOCATION.min &&
          game.portBlock.rangeEnd <= PORT_ALLOCATION.max,
        `${game.name}'s band falls outside the allocator's bounds`,
      );
    }
  });

  it('never lets two titles be handed overlapping blocks', () => {
    const bands = Object.values(GAMES)
      .map((g) => ({ name: g.name, ...g.portBlock }))
      .sort((a, b) => a.base - b.base);

    for (let i = 1; i < bands.length; i += 1) {
      const previous = bands[i - 1]!;
      const current = bands[i]!;
      assert.ok(
        current.base > previous.rangeEnd,
        `${current.name} starts at ${current.base}, inside ${previous.name}'s band`,
      );
    }
  });

  it('keeps administrative ports out of the public set for every game', () => {
    for (const game of Object.values(GAMES)) {
      for (const port of game.ports) {
        if (/rcon|battleye/i.test(port.key)) {
          assert.equal(port.public, false, `${game.name} exposes ${port.key} publicly`);
        }
      }
    }
  });

  it('gives Arma 3 the documented five-port layout', () => {
    const { base } = GAMES.arma3.portBlock;
    const actual = Object.fromEntries(
      GAMES.arma3.ports.map((p) => [p.key, base + p.offset]),
    );
    assert.deepEqual(actual, {
      game: 2302,
      steamQuery: 2303,
      steamMaster: 2304,
      von: 2305,
      battleye: 2306,
    });
  });
});

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

describe('Server names', () => {
  it('accepts a realistic name with a Discord invite', () => {
    const name = 'TDE Survival NA #1 - https://discord.gg/ykkkjwDnAD For mod List';
    assert.equal(serverNameSchema.safeParse(name).success, true);
  });

  it('accepts tags, separators and emoji', () => {
    for (const name of [
      '[EU] Overthrow | Vanilla+ | 24/7',
      '★ Reforger PVP ★ (Modded)',
      'Server #3 — 100% uptime, no rules!',
    ]) {
      assert.equal(serverNameSchema.safeParse(name).success, true, `"${name}" should be accepted`);
    }
  });

  it('rejects control and bidi characters', () => {
    // U+202E flips rendering direction and can disguise one name as another.
    for (const name of ['bad name', 'evil\u202Ename', 'two\nlines']) {
      assert.equal(serverNameSchema.safeParse(name).success, false, `"${name}" should be rejected`);
    }
  });

  it('still enforces length', () => {
    assert.equal(serverNameSchema.safeParse('ab').success, false);
    assert.equal(serverNameSchema.safeParse('x'.repeat(97)).success, false);
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
