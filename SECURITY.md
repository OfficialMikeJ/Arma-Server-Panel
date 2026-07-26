# Security

Threat model, control inventory and known limitations for Arma Server Panel.

Read the [Known limitations](#known-limitations) section. It is the honest part, and it is the part
that matters when you decide how to deploy this.

---

## Threat model

**Assets.** Game server data and saves; operator credentials; the host itself (a container escape is
host compromise); operators' home IP addresses; third-party credentials the panel is trusted with
(Steam, Discord, AI provider keys); the audit trail.

**Adversaries considered.**

| Adversary | Capability assumed |
| --- | --- |
| Unauthenticated internet | Full request forgery, credential stuffing, enumeration, DoS |
| Registered user | A valid account and one or more servers |
| Server member | Delegated access to someone else's server |
| Malicious player | Controls strings that reach the console: names, chat, mod titles |
| Compromised game server | Full code execution *inside one container* |
| Read-only DB access | A database dump, without the environment |
| Hostile third party | Controls a webhook or AI endpoint the user pointed us at |

**Explicitly out of scope.** A compromised host kernel; a malicious platform administrator (they are
the trust root by definition); supply-chain compromise of npm dependencies; physical access.

---

## Controls

### Authentication

| Control | Where |
| --- | --- |
| Users are **TOTP-only** — no password exists, so password reuse and credential stuffing do not apply | `routes/auth.ts` |
| RFC 6238 implemented directly, constant-time comparison, ±1 step window | `security/totp.ts` |
| **Replay blocking**: the accepted step is persisted; any step at or below it is refused | `security/totp.ts`, `accounts.totpLastStep` |
| Argon2id at 46 MiB / t=3 / p=1 for the admin password and recovery codes | `security/password.ts` |
| Timing-equalised dummy verify so a missing account costs the same as a wrong password | `verifyPasswordDummy` |
| Login always issues a challenge, even for an unknown username — responses are identical | `routes/auth.ts` |
| Progressive lockout: 3→30 s, 5→5 min, 8→30 min, 12→24 h, decaying after quiet time | `security/lockout.ts` |
| Discord OAuth with PKCE, server-side state, and browser binding via user-agent hash | `modules/auth/discord.ts` |
| Recovery codes: Argon2id-hashed, single-use, all candidates always tested so timing reveals nothing | `security/recovery-codes.ts` |

### Sessions and CSRF

- Opaque 256-bit tokens. Only the SHA-256 digest is stored, so a database read yields nothing usable.
  No JWTs — revocation is immediate, and there is no `alg: none` class of bug.
- `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Strict`. The `__Host-` prefix means a sibling
  subdomain cannot overwrite them, which is the standard setup for cookie-tossing attacks against
  double-submit CSRF.
- Rotated every 15 minutes and on every privilege change (password change, TOTP enrolment, step-up).
- Idle and absolute timeouts: 1 h / 12 h normally, **20 min / 4 h** for elevated admin sessions.
- Bound to a hashed user-agent; a mismatch revokes the session. IP is deliberately *not* bound —
  mobile clients roam and would be logged out constantly.
- CSRF in three independent layers: `SameSite=Strict`; `Origin` / `Sec-Fetch-Site` verification on
  every mutating request; and a double-submit token that must match both the cookie *and* the digest
  recorded on the session.

### Secrets at rest

AES-256-GCM envelopes with a version byte for key rotation and **per-purpose AAD**, so an envelope
lifted from `accounts.totpSecretEnc` cannot be replayed into `ai_providers.apiKeyEnc`.

Encrypted: TOTP seeds, Discord refresh tokens, per-server RCON/admin passwords, webhook URLs and
Pushover tokens, AI provider keys, Docker TLS bundles, and multi-step auth challenge payloads.

IP addresses and user agents are stored only as HMAC-SHA256 digests under a separate pepper, so a
database leak cannot be reversed with a rainbow table.

### Container isolation

Every game server gets its own container with:

```
cap_drop: ALL              no capabilities, none added back
no-new-privileges:true     setuid binaries cannot raise privileges
ReadonlyRootfs: true       only the data volume is writable
tmpfs noexec,nosuid        a dropped payload cannot be executed from /tmp
User: 10000:10000          never root
PidsLimit: 512             fork bombs are bounded
MemorySwap == Memory       no swap; OOM is better than thrashing a game server
enable_icc: false          servers cannot reach each other on the bridge
RestartPolicy: no          the panel owns crash handling, so crashes are visible
```

The Docker socket is never mounted into a game container. `dockerode`'s API is used throughout —
nothing shells out with user input anywhere in the codebase.

### Input handling

- Zod validation on every route, with allowlists rather than denylists.
- **Path traversal**: schema rejection, then authoritative re-resolution against the server root,
  then symlink resolution and a second containment check. Symlinks are never listed or followed.
- **Command injection**: `execInContainer` takes an argv array; there is no `sh -c` path.
- **Config injection**: Arma 3's text config is generated with escaping for quotes, backslashes and
  control characters — a server name containing `"; adminPassword = "` cannot become two directives.
- **Console output** is treated as attacker-controlled. ANSI escapes and control characters are
  stripped server-side, and the UI renders text nodes only — no `dangerouslySetInnerHTML` anywhere.
- **Discord payloads** escape markdown and strip `@everyone`/`@here`, with `allowed_mentions: []` as
  a second layer.
- **Preset import** treats an Arma 3 HTML preset as text, scraped with a bounded regex. It is never
  parsed as XML (XXE) or rendered.

### SSRF

`safeFetch` resolves DNS itself, validates **every** answer against a non-routable-address list, then
pins the connection to the address it validated — closing the rebinding window between check and
connect. TLS still verifies against the original hostname. https only, credentials-in-URL rejected,
redirects followed manually with each hop re-validated, and a hard response size cap.

The one deliberate exception is UPnP discovery, which must talk to a LAN address. Exposure there is
bounded instead: http only, private address required, 512 KB cap, 4 s timeout, and a targeted regex
rather than an XML parser.

### Rate limiting and abuse

Durable Postgres counters (surviving restarts and spanning instances) with a per-process cache that
can only ever be *more* strict. Layered: global per-IP, per-route, per-account, per-API-key.

The username policy from the specification is implemented as: an unacceptable username produces one
warning; submitting **the same** username again bans registration from that client for 2 hours.
"Same" is compared on the screening-normalised form, so `Sh1tlord` and `shitlord` count as one
attempt — otherwise the rule would be bypassed by changing a character. Only genuinely abusive
rejections (offensive, impersonation, homoglyph) count toward the ban; "too short" or "already
taken" carry no penalty.

Username screening folds leetspeak, Cyrillic homoglyphs and repeated characters before matching, and
canonicalisation blocks look-alike account squatting (`Bacon_Man` and `baconman` collide).

### Audit

Append-only and hash-chained: each row's hash covers its content plus the previous row's hash.
Appends are serialised with a Postgres advisory lock so concurrent writers cannot fork the chain.
`POST /api/v1/admin/audit/verify` walks the chain and names the first row where it breaks.

Audit failures are logged loudly but never block the caller — an audit outage must not stop someone
stopping a runaway server.

---

## Known limitations

Being straight about these is more useful than a clean-looking list of controls.

1. **`Admin` / `Password123` is a weak credential.** It is required by the specification. It is
   scoped as tightly as possible (first-boot only, restricted session, retired permanently on first
   password change, fully audited), but between first boot and first login the panel must not be
   reachable from the internet. There is no way to make a published default password safe.

2. **The API needs the Docker socket.** That is equivalent to host root. Mitigate with
   `--userns-remap=default` (the API warns at startup if it is off) and, in a hostile environment, a
   socket proxy that allowlists only the endpoints the panel actually calls.

3. **Direct port forwarding exposes the operator's IP.** This is inherent — players connect to that
   address. Only relay mode avoids it, and the UI says so on the networking screen rather than
   burying it.

4. **Carrier-grade NAT cannot be worked around from the LAN.** No implementation of UPnP, NAT-PMP or
   PCP can open an inbound port through it. The relay is the answer; there is no other one.

5. **BattlEye RCON has no transport security.** The password crosses the wire in the login packet.
   The panel therefore never publishes the RCON port (`public: false` in the game definition) and
   speaks to it only across the container bridge.

6. **The AI assistant sends data to a third party.** Redaction is aggressive and consent is
   per-category, but an operator who ticks "console" is sending console output to their chosen
   provider. The assistant cannot act on its own, so the failure mode is disclosure, not compromise.

7. **Audit retention is bounded at 400 days.** Chain integrity is only verifiable forward from the
   oldest retained entry. Export before pruning if you need longer.

8. **Storage quotas need filesystem support.** `storageGib` is enforced by XFS/ZFS project quotas on
   the data volume. On a filesystem without them, the value is advisory and the panel reports usage
   rather than blocking writes.

9. **No email.** Account recovery is recovery codes only. Lose the authenticator and all ten codes
   and the account is unrecoverable without administrator intervention. This is a deliberate
   trade — no email means no email-based account takeover.

---

## Hardening checklist

- [ ] `ENCRYPTION_KEY` and `HASH_PEPPER` are distinct 32-byte random values
- [ ] Docker started with `--userns-remap=default`
- [ ] `TRUST_PROXY` set only behind a proxy you control, with `TRUSTED_PROXY_CIDRS` populated
- [ ] TLS terminated in front of the API; `REQUIRE_SECURE_COOKIES=true`
- [ ] Default admin password changed and TOTP enrolled **before** the panel is publicly reachable
- [ ] Postgres reachable only from the API, on the internal network
- [ ] Relay deployed if any operator self-hosts from a residential connection
- [ ] `POST /admin/audit/verify` scheduled as a periodic integrity check
- [ ] Database backups encrypted — they contain the ciphertext of every stored secret
- [ ] `ENCRYPTION_KEY` backed up separately from the database (losing it loses every TOTP seed)

---

## Reporting a vulnerability

Do not open a public issue. Contact the panel operator directly with reproduction steps and the
affected version.
