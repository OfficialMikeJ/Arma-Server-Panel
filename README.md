# Arma Server Panel

Specialised hosting control panel for **Arma Reforger**, **Arma 3** and **Arma 4** (supported on
launch day — the adapter is already written).

Each game server runs in its own hardened Docker container with granular CPU, memory, storage and
bandwidth limits, a live console, a mod manager with presets and load ordering, an HTTP API, Discord
and Pushover integrations, automatic port opening, and an optional relay that keeps a residential
IP address private. Runs the same way on a VPS, a dedicated box, or a home lab.

---

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [First login](#first-login)
- [Architecture](#architecture)
- [Networking: how servers become reachable](#networking-how-servers-become-reachable)
- [The AI assistant](#the-ai-assistant)
- [HTTP API](#http-api)
- [Security](#security)
- [Development](#development)

---

## Quick start

One command. It checks your hardware, installs Docker if it is missing, generates your encryption
keys, writes `.env`, and starts everything:

```bash
curl -fsSL https://raw.githubusercontent.com/OfficialMikeJ/Arma-Server-Panel/main/install.sh | sudo sh
```

It prints your URL and first-login credentials when it finishes.

Prefer to read it first — it runs as root, so that is a reasonable thing to want:

```bash
curl -fsSL https://raw.githubusercontent.com/OfficialMikeJ/Arma-Server-Panel/main/install.sh -o install.sh
less install.sh
sudo sh install.sh
```

### Manual install

```bash
git clone https://github.com/OfficialMikeJ/Arma-Server-Panel.git
cd Arma-Server-Panel
cp .env.example .env

# Fill in the required values:
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "HASH_PEPPER=$(openssl rand -hex 32)"    >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
echo "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" >> .env
# Then set PUBLIC_APP_URL, NEXT_PUBLIC_API_URL and NEXT_PUBLIC_APP_URL to your address.

docker compose up -d --build && docker compose up -d
```

Database migrations and the administrator account are created automatically on first start. Game
server images build themselves the first time you create a server of that game — nothing to build by
hand.

### After an update

```bash
git pull
docker compose up -d --build && docker compose up -d
```

### Behind a reverse proxy

No proxy is included. Put your own in front (Nginx Proxy Manager, Traefik, Caddy) or reach it
directly on the LAN. Ports come from `.env`: `WEB_HOST_PORT` (default 3002) and `API_HOST_PORT`
(default 3004).

Point the proxy at `WEB_HOST_PORT` and **enable WebSocket support** on that proxy host, or the live
server console will not connect. Set `TRUST_PROXY=true` and put the proxy's subnet in
`TRUSTED_PROXY_CIDRS` so rate limits and audit entries record real client addresses rather than the
proxy's — without an explicit list, forwarded headers are ignored entirely, because otherwise any
client could forge its own address.

---

## Requirements

These are **hard requirements**, not recommendations. The panel measures the host during setup and
refuses to finish — and refuses to accept registrations — if any of them are not met.

| Resource | Minimum |
| --- | --- |
| Memory | 8 GB |
| CPU | 4 cores / threads |
| Storage | 120 GB |
| Network | 50 Mbps down **and** up |

They live in [`packages/shared/src/constants.ts`](packages/shared/src/constants.ts) and are
deliberately not configurable from the environment or the database. The network figure is measured
with a real throughput test that discards TCP slow-start; air-gapped installs can attest to their
capacity with `SPEEDTEST_MANUAL_*`, which is recorded in the report as *declared* rather than
*measured*.

Also needed: Node.js 20.11+, PostgreSQL 14+, and Docker with `--userns-remap` enabled (strongly
recommended — see [Security](#security)).

---

## First login

The seed creates the administrator account the specification calls for:

```
Username:  Admin
Password:  Password123
```

A shipped default credential is a weakness by definition, so it is fenced in as tightly as the
requirement allows:

1. It only works while `platform_settings.bootstrap_credential_active` is `true`. That flag is set
   `false` the moment the password is changed, and **no API path can set it back**.
2. The session it produces is *restricted*. Every route except change-password and TOTP enrolment
   returns `403 password_change_required` — it cannot touch a server, read a console, or create an
   API key.
3. The replacement password must be 14+ characters with mixed case, a digit and a symbol, and cannot
   contain `password123`, `admin` or other well-known phrases.
4. TOTP enrolment is mandatory immediately afterwards. The account is not `ACTIVE` until it is done.
5. Every use of the default credential is written to the audit log, successful or not.

**Do not expose the panel to the internet before completing both steps.**

---

## Architecture

```
Arma-Panel/
├── packages/shared/       Types, Zod schemas, game definitions, constants
├── apps/api/              Fastify + Prisma. Orchestration, auth, security core
│   ├── src/security/      Crypto, TOTP, sessions, CSRF, rate limits, audit, SSRF
│   ├── src/modules/
│   │   ├── docker/        Container spec + lifecycle
│   │   ├── games/         Per-title adapters, A2S and BattlEye RCON protocols
│   │   ├── network/       NAT-PMP / PCP / UPnP, relay client, port allocator
│   │   ├── servers/       Lifecycle, supervisor, console buffer
│   │   ├── mods/          Mod manager, preset import/export
│   │   ├── files/         Path-confined file manager
│   │   ├── ai/            Redaction, provider calls, action allowlist
│   │   └── host/          Requirements gate, throughput measurement
│   └── src/routes/        REST + WebSocket
├── apps/web/              Next.js 15. Marketing site at /, panel at /panel
├── services/relay/        Relay daemon (deploy on a host with a public IP)
└── docker/                Game server images, API/web images, proxy config
```

**Adding a game title** means three things: an entry in
[`games.ts`](packages/shared/src/games.ts), an adapter under
[`apps/api/src/modules/games/adapters/`](apps/api/src/modules/games/adapters/), and a Dockerfile.
Nothing in the orchestration, resource, networking, console or AI layers changes. Arma 4 is already
wired up this way — when it ships, set its Steam app id and flip `released` to `true`.

---

## Networking: how servers become reachable

The panel runs in three quite different places, and treats them as three different problems
rather than assuming everyone is at home behind a consumer router.

**On a public address** — a VPS, a dedicated or colocated machine, or a home lab on a routed
prefix — there is nothing to forward. The panel detects this at setup, skips NAT discovery
entirely, and tells you the one thing that can still block a player: the host firewall, or your
provider's security group. It will not ask you to configure a router you do not have.

**Behind a router you control** — the common home lab case — the panel opens ports itself over
NAT-PMP, PCP or UPnP, renews the leases, and falls back to printing the exact manual forward if
the router refuses.

**Behind carrier-grade NAT**, or when you would rather players never saw your address, the relay
carries traffic over an outbound-initiated tunnel. Nothing LAN-side can open an inbound port
through CGNAT; that is a property of the network, not something the panel can work around.

| Method | Reachable | Hides your IP | Works behind CGNAT | Typical deployment |
| --- | --- | --- | --- | --- |
| **Direct** | yes | no | n/a | VPS, dedicated, colo, routed home lab |
| **Relay** | yes | **yes** | **yes** | anywhere privacy matters |
| NAT-PMP | yes | no | no | home lab behind a router |
| PCP | yes | no | no | home lab behind a router |
| UPnP IGD | yes | no | no | home lab behind a router |
| Manual forward | yes | no | no | router with UPnP disabled |

On a hosted machine, players seeing its address is the point rather than a leak, and the panel
says so instead of warning about it.

`preferred: "auto"` picks the relay when one is configured, then falls back through NAT-PMP, PCP and
UPnP. Leases are renewed every 5 minutes by the scheduler, so a server does not silently drop off
mid-session. If nothing works, the panel reports exactly which method failed and why.

**Why the relay matters:** no LAN-side protocol can open an inbound port through carrier-grade NAT —
that is a property of the network, not a limitation of this code. The relay is the only option that
covers those users, and it is the only one that keeps the address private. Deploy
[`services/relay`](services/relay) on any host with a public IPv4 address:

```bash
RELAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
RELAY_PUBLIC_HOST=relay.example.com \
npm start -w @asp/relay
```

The node dials **outbound** to the relay, so its own NAT keeps the path open and no inbound port is
needed on the operator's network.

---

## The AI assistant

Connect your own Claude, OpenAI or Codex key. The assistant reads the context you explicitly tick —
console, config, mods, metrics, specific files — and proposes what to change.

Three properties make this safe enough to ship:

1. **Nothing leaves the host unredacted.** RCON passwords, admin passwords, webhook URLs, Steam
   credentials, API keys and IP addresses are stripped before the request is built.
2. **The model cannot act.** It returns proposed actions as structured data. Every one needs a human
   with the matching permission to approve it, and each approval is audited. Prompt injection from a
   hostile mod name or a player's chat line in the log therefore cannot cause an action — the worst
   it can do is produce a bad suggestion.
3. **Allowlisted actions only.** Anything outside `ALLOWED_ACTIONS` is discarded. Reinstall and
   delete can never be granted autonomously, and reinstall always goes through the normal
   type-the-server-name confirmation.

---

## HTTP API

```bash
curl -H "x-api-key: asp_live_..." https://panel.example.com/api/v1/servers
```

Keys are scoped to specific permissions and optionally specific servers and CIDR ranges, always
expire, and can only ever *narrow* what their owner could already do. The raw key is shown once at
creation; only its SHA-256 digest is stored.

The live console is available over WebSocket at
`/api/v1/servers/:id/console/stream` and over plain HTTP for scrollback and command submission.

---

## Security

The full threat model, control inventory and known limitations are in
**[SECURITY.md](SECURITY.md)**. In brief:

- **Authentication** — users are TOTP-only, no password exists. Administrators use Argon2id
  (46 MiB, t=3) plus TOTP. Codes are replay-blocked by a persisted step counter.
- **Sessions** — opaque 256-bit tokens, SHA-256 at rest, rotating, `__Host-` prefixed,
  `SameSite=Strict`, with idle *and* absolute timeouts (much shorter when elevated).
- **CSRF** — three independent layers: SameSite, Origin/Sec-Fetch-Site verification, and a
  double-submit token bound to the session.
- **Secrets at rest** — AES-256-GCM with per-purpose AAD, so an envelope lifted from one column
  cannot be replayed into another. Key rotation is versioned.
- **Container isolation** — `cap_drop: ALL`, `no-new-privileges`, read-only rootfs, noexec tmpfs,
  uid 10000, pids limit, no swap, and `enable_icc: false` so servers cannot reach each other.
- **SSRF** — DNS is resolved by us, every answer validated, and the connection pinned to the
  validated address, which closes the rebinding window between check and connect.
- **Audit** — append-only and hash-chained under an advisory lock; `POST /admin/audit/verify`
  detects tampering and names the row where the chain breaks.

**Enable Docker user-namespace remapping** (`dockerd --userns-remap=default`). The API warns at
startup if it is off. Without it, a container escape lands on host root.

---

## Development

```bash
npm run dev          # api + web with hot reload
npm run typecheck    # all workspaces
npm test             # api unit tests
npm run db:migrate   # create a new migration
npm run db:studio    # browse the database
```

Environment is validated by Zod at startup ([`config/env.ts`](apps/api/src/config/env.ts)) and the
process **refuses to boot** on a missing, weak or placeholder secret, an http origin in production,
or `TRUST_PROXY` without an explicit CIDR allowlist.

---

*Not affiliated with Bohemia Interactive. Arma is a trademark of Bohemia Interactive a.s.*
