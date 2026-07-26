/**
 * Arma Server Panel relay daemon.
 *
 * Deploy this on a host with a public IPv4 address. It gives self-hosted game
 * servers a public endpoint without exposing the operator's own IP, and works
 * behind carrier-grade NAT where no port-forwarding protocol can.
 *
 * Two planes:
 *
 *   Control (HTTPS, bearer token)
 *     POST   /v1/allocations        -> reserve a public UDP port, get a session token
 *     DELETE /v1/allocations/:token -> release it
 *     GET    /health
 *
 *   Data (UDP)
 *     A node authenticates with its session token and an HMAC, which registers
 *     the source address as that allocation's tunnel endpoint. Player packets
 *     arriving on the allocated public port are encapsulated and forwarded down
 *     that flow; replies are unwrapped and sent back to the player.
 *
 * Because the node dials outbound, its NAT keeps the path open and no inbound
 * port is needed on its network.
 *
 * Threat notes:
 *   * The session token proves ownership; the HMAC over (token|serverId) with
 *     the shared control secret proves the token was not merely observed.
 *   * Only one tunnel endpoint may hold an allocation at a time; a later
 *     authentication from a different address is refused unless the current
 *     endpoint has gone silent past the idle timeout, so a race cannot steal
 *     someone's traffic.
 *   * Per-allocation client tables are bounded, and unknown-client packets are
 *     dropped rather than queued.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONTROL_PORT = Number(process.env.RELAY_CONTROL_PORT ?? 8080);
const DATA_PORT = Number(process.env.RELAY_DATA_PORT ?? 9000);
const PUBLIC_HOST = process.env.RELAY_PUBLIC_HOST ?? '';
const CONTROL_TOKEN = process.env.RELAY_TOKEN ?? '';
const PORT_RANGE_START = Number(process.env.RELAY_PORT_RANGE_START ?? 30000);
const PORT_RANGE_END = Number(process.env.RELAY_PORT_RANGE_END ?? 31000);

if (!CONTROL_TOKEN || CONTROL_TOKEN.length < 32) {
  console.error('RELAY_TOKEN must be set and at least 32 characters. Refusing to start.');
  process.exit(1);
}
if (!PUBLIC_HOST) {
  console.error('RELAY_PUBLIC_HOST must be set to this relay’s public address. Refusing to start.');
  process.exit(1);
}

const MAGIC = 0xa5;
const VERSION = 1;
const HEADER_BYTES = 12;
const MAX_DATAGRAM = 2048;
const MAX_CLIENTS_PER_ALLOCATION = 512;
const TUNNEL_IDLE_MS = 90_000;
const CLIENT_IDLE_MS = 120_000;
const ALLOCATION_IDLE_MS = 30 * 60_000;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface PlayerClient {
  id: number;
  address: string;
  port: number;
  lastSeen: number;
}

interface Allocation {
  sessionToken: string;
  serverId: string;
  portKey: string;
  publicPort: number;
  socket: Socket;
  /** Where the node's tunnel is dialling from, once authenticated. */
  tunnel: { address: string; port: number; lastSeen: number } | null;
  clientsById: Map<number, PlayerClient>;
  clientsByAddress: Map<string, PlayerClient>;
  nextClientId: number;
  createdAt: number;
  lastActivity: number;
}

const allocations = new Map<string, Allocation>();
const allocationsByPort = new Map<number, Allocation>();

/* ------------------------------------------------------------------ */
/* Packet framing                                                      */
/* ------------------------------------------------------------------ */

function buildHeader(type: number, clientId: number, sequence: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(MAGIC, 0);
  header.writeUInt8(VERSION, 1);
  header.writeUInt8(type, 2);
  header.writeUInt8(0, 3);
  header.writeUInt32BE(clientId >>> 0, 4);
  header.writeUInt32BE(sequence >>> 0, 8);
  return header;
}

function parseHeader(packet: Buffer): { type: number; clientId: number } | null {
  if (packet.length < HEADER_BYTES) return null;
  if (packet.readUInt8(0) !== MAGIC || packet.readUInt8(1) !== VERSION) return null;
  return { type: packet.readUInt8(2), clientId: packet.readUInt32BE(4) };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ */
/* Control plane                                                       */
/* ------------------------------------------------------------------ */

function allocatePublicPort(): number | null {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    if (!allocationsByPort.has(port)) return port;
  }
  return null;
}

async function createAllocation(body: {
  serverId: string;
  portKey: string;
}): Promise<{ ok: true; allocation: Allocation } | { ok: false; error: string }> {
  const publicPort = allocatePublicPort();
  if (publicPort === null) return { ok: false, error: 'No public ports available' };

  const sessionToken = randomBytes(24).toString('base64url');
  const socket = createSocket('udp4');

  const allocation: Allocation = {
    sessionToken,
    serverId: body.serverId,
    portKey: body.portKey,
    publicPort,
    socket,
    tunnel: null,
    clientsById: new Map(),
    clientsByAddress: new Map(),
    nextClientId: 1,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  // Player-facing socket for this allocation.
  socket.on('message', (packet, rinfo) => {
    allocation.lastActivity = Date.now();

    if (!allocation.tunnel) return; // node has not connected yet
    if (packet.length === 0 || packet.length > MAX_DATAGRAM) return;

    const key = `${rinfo.address}:${rinfo.port}`;
    let client = allocation.clientsByAddress.get(key);

    if (!client) {
      if (allocation.clientsByAddress.size >= MAX_CLIENTS_PER_ALLOCATION) {
        pruneClients(allocation);
        if (allocation.clientsByAddress.size >= MAX_CLIENTS_PER_ALLOCATION) return;
      }
      client = {
        id: allocation.nextClientId++,
        address: rinfo.address,
        port: rinfo.port,
        lastSeen: Date.now(),
      };
      allocation.clientsById.set(client.id, client);
      allocation.clientsByAddress.set(key, client);
    }

    client.lastSeen = Date.now();

    dataSocket.send(
      Buffer.concat([buildHeader(1, client.id, 0), packet]),
      allocation.tunnel.port,
      allocation.tunnel.address,
      () => undefined,
    );
  });

  socket.on('error', (error) => {
    console.error(`[relay] allocation ${sessionToken.slice(0, 8)} socket error:`, error.message);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(publicPort, () => resolve());
  });

  allocations.set(sessionToken, allocation);
  allocationsByPort.set(publicPort, allocation);

  console.log(
    `[relay] allocated udp/${publicPort} for server ${body.serverId} (${body.portKey})`,
  );

  return { ok: true, allocation };
}

function releaseAllocation(sessionToken: string): boolean {
  const allocation = allocations.get(sessionToken);
  if (!allocation) return false;

  try {
    allocation.socket.close();
  } catch {
    // already closed
  }
  allocations.delete(sessionToken);
  allocationsByPort.delete(allocation.publicPort);

  console.log(`[relay] released udp/${allocation.publicPort}`);
  return true;
}

function pruneClients(allocation: Allocation): void {
  const cutoff = Date.now() - CLIENT_IDLE_MS;
  for (const [key, client] of allocation.clientsByAddress) {
    if (client.lastSeen < cutoff) {
      allocation.clientsByAddress.delete(key);
      allocation.clientsById.delete(client.id);
    }
  }
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), CONTROL_TOKEN);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

const controlServer = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'relay'}`);

    if (url.pathname === '/health') {
      return json(response, 200, {
        status: 'ok',
        allocations: allocations.size,
        portsFree: PORT_RANGE_END - PORT_RANGE_START + 1 - allocationsByPort.size,
      });
    }

    if (!authorized(request)) {
      return json(response, 401, { error: 'unauthorized' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/allocations') {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request) {
        total += (chunk as Buffer).length;
        if (total > 8192) {
          request.destroy();
          return json(response, 413, { error: 'payload_too_large' });
        }
        chunks.push(chunk as Buffer);
      }

      let body: { serverId?: unknown; portKey?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(response, 400, { error: 'invalid_json' });
      }

      const serverId = String(body.serverId ?? '');
      const portKey = String(body.portKey ?? '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverId) || !/^[a-zA-Z]{1,32}$/.test(portKey)) {
        return json(response, 400, { error: 'invalid_parameters' });
      }

      const result = await createAllocation({ serverId, portKey });
      if (!result.ok) return json(response, 503, { error: result.error });

      return json(response, 201, {
        publicHost: PUBLIC_HOST,
        publicPort: result.allocation.publicPort,
        dataHost: PUBLIC_HOST,
        dataPort: DATA_PORT,
        sessionToken: result.allocation.sessionToken,
        expiresAt: new Date(Date.now() + ALLOCATION_IDLE_MS).toISOString(),
      });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/allocations/')) {
      const token = decodeURIComponent(url.pathname.slice('/v1/allocations/'.length));
      const released = releaseAllocation(token);
      return json(response, released ? 200 : 404, { ok: released });
    }

    return json(response, 404, { error: 'not_found' });
  })().catch((error) => {
    console.error('[relay] control error:', error);
    if (!response.headersSent) json(response, 500, { error: 'internal_error' });
  });
});

/* ------------------------------------------------------------------ */
/* Data plane                                                          */
/* ------------------------------------------------------------------ */

const dataSocket = createSocket('udp4');

dataSocket.on('message', (packet, rinfo) => {
  const header = parseHeader(packet);
  if (!header) return;

  /* ---- Authentication ---- */
  if (header.type === 3) {
    const payload = packet.subarray(HEADER_BYTES);
    const separator = payload.indexOf(0);
    if (separator === -1) return;

    const sessionToken = payload.subarray(0, separator).toString('utf8');
    const mac = payload.subarray(separator + 1);

    const allocation = allocations.get(sessionToken);
    if (!allocation) {
      dataSocket.send(
        Buffer.concat([buildHeader(5, 0, 0), Buffer.from('unknown session', 'utf8')]),
        rinfo.port,
        rinfo.address,
        () => undefined,
      );
      return;
    }

    const expected = createHmac('sha256', CONTROL_TOKEN)
      .update(`${sessionToken}|${allocation.serverId}`)
      .digest();

    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      dataSocket.send(
        Buffer.concat([buildHeader(5, 0, 0), Buffer.from('bad signature', 'utf8')]),
        rinfo.port,
        rinfo.address,
        () => undefined,
      );
      return;
    }

    // An allocation already served by a live tunnel cannot be hijacked.
    const existing = allocation.tunnel;
    const sameEndpoint = existing?.address === rinfo.address && existing?.port === rinfo.port;
    if (existing && !sameEndpoint && Date.now() - existing.lastSeen < TUNNEL_IDLE_MS) {
      dataSocket.send(
        Buffer.concat([buildHeader(5, 0, 0), Buffer.from('session already active', 'utf8')]),
        rinfo.port,
        rinfo.address,
        () => undefined,
      );
      return;
    }

    allocation.tunnel = { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() };
    allocation.lastActivity = Date.now();

    dataSocket.send(buildHeader(4, 0, 0), rinfo.port, rinfo.address, () => undefined);
    console.log(
      `[relay] tunnel up for udp/${allocation.publicPort} from ${rinfo.address}:${rinfo.port}`,
    );
    return;
  }

  /* ---- Everything else must come from an authenticated tunnel ---- */
  const allocation = [...allocations.values()].find(
    (candidate) =>
      candidate.tunnel?.address === rinfo.address && candidate.tunnel?.port === rinfo.port,
  );
  if (!allocation?.tunnel) return;

  allocation.tunnel.lastSeen = Date.now();
  allocation.lastActivity = Date.now();

  if (header.type === 2) return; // keepalive

  if (header.type === 1) {
    const client = allocation.clientsById.get(header.clientId);
    if (!client) return;

    const payload = packet.subarray(HEADER_BYTES);
    if (payload.length === 0 || payload.length > MAX_DATAGRAM) return;

    allocation.socket.send(payload, client.port, client.address, () => undefined);
  }
});

dataSocket.on('error', (error) => {
  console.error('[relay] data socket error:', error.message);
});

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const allocation of [...allocations.values()]) {
    pruneClients(allocation);

    if (allocation.tunnel && now - allocation.tunnel.lastSeen > TUNNEL_IDLE_MS) {
      console.log(`[relay] tunnel for udp/${allocation.publicPort} went silent`);
      allocation.tunnel = null;
    }
    // An allocation nobody has used in a long time is reclaimed so its public
    // port returns to the pool.
    if (now - allocation.lastActivity > ALLOCATION_IDLE_MS && !allocation.tunnel) {
      releaseAllocation(allocation.sessionToken);
    }
  }
}, 30_000).unref();

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

dataSocket.bind(DATA_PORT, () => {
  console.log(`[relay] data plane listening on udp/${DATA_PORT}`);
});

controlServer.listen(CONTROL_PORT, () => {
  console.log(`[relay] control plane listening on tcp/${CONTROL_PORT}`);
  console.log(`[relay] public host ${PUBLIC_HOST}, ports ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  console.log('[relay] terminate TLS in front of the control plane - it speaks plain HTTP.');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[relay] ${signal} received, shutting down`);
    for (const allocation of [...allocations.values()]) releaseAllocation(allocation.sessionToken);
    controlServer.close();
    dataSocket.close();
    process.exit(0);
  });
}
