/**
 * Relay tunnelling.
 *
 * Why this exists: a direct port forward makes the server reachable, but it
 * also shows every player the operator's home IP address. It also cannot work
 * at all behind carrier-grade NAT. The relay solves both.
 *
 * How it works:
 *   1. Control plane (HTTPS): the node asks the relay host to allocate a
 *      public UDP port and returns a session token.
 *   2. Data plane (UDP): the node opens an *outbound* session to the relay,
 *      which keeps the NAT pinhole alive. Player packets arriving at the relay
 *      are encapsulated with a small header identifying the player, sent down
 *      the existing outbound flow, and unwrapped by the node before delivery
 *      to the local game port. Replies take the reverse path.
 *
 * Because the flow is outbound-initiated, no inbound port is needed on the
 * operator's network, and players only ever see the relay's address.
 *
 * Datagram header (12 bytes):
 *   0      magic 0xA5
 *   1      version (1)
 *   2      type    (1 = data, 2 = keepalive, 3 = auth, 4 = auth-ok, 5 = error)
 *   3      flags
 *   4..7   client id (u32be) - opaque handle the relay assigns per player
 *   8..11  sequence (u32be)
 */

import { createSocket, type Socket } from 'node:dgram';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { safeFetch } from '../../security/ssrf.js';

const MAGIC = 0xa5;
const VERSION = 1;
const HEADER_BYTES = 12;
const KEEPALIVE_MS = 15_000;
/** Player sessions idle for longer than this are forgotten. */
const CLIENT_IDLE_MS = 120_000;
const MAX_DATAGRAM = 2048;
const MAX_CLIENTS = 512;

type PacketType = 1 | 2 | 3 | 4 | 5;

export interface RelayTunnelResult {
  success: boolean;
  publicHost: string;
  remotePort: number;
  message: string;
}

interface ActiveTunnel {
  serverId: string;
  portKey: string;
  socket: Socket;
  keepalive: NodeJS.Timeout;
  sessionToken: string;
  remotePort: number;
  localPort: number;
  /** relay client id -> last activity, so stale entries can be dropped. */
  clients: Map<number, number>;
  sequence: number;
  closed: boolean;
}

const tunnels = new Map<string, ActiveTunnel>();

function tunnelKey(serverId: string, portKey: string): string {
  return `${serverId}:${portKey}`;
}

export function isRelayConfigured(): boolean {
  const config = loadConfig();
  return config.RELAY_ENABLED && Boolean(config.RELAY_ENDPOINT && config.RELAY_TOKEN);
}

/* ------------------------------------------------------------------ */
/* Control plane                                                       */
/* ------------------------------------------------------------------ */

interface RelayAllocation {
  publicHost: string;
  publicPort: number;
  dataHost: string;
  dataPort: number;
  sessionToken: string;
  expiresAt: string;
}

async function allocateOnRelay(params: {
  serverId: string;
  portKey: string;
  protocol: 'udp' | 'tcp';
}): Promise<RelayAllocation> {
  const config = loadConfig();

  const response = await safeFetch(`${config.RELAY_ENDPOINT}/v1/allocations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.RELAY_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: params.serverId,
      portKey: params.portKey,
      protocol: params.protocol,
    }),
    timeoutMs: 10_000,
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Relay refused the allocation (HTTP ${response.status})`);
  }

  const allocation = JSON.parse(response.body) as RelayAllocation;
  if (!allocation.publicHost || !allocation.publicPort || !allocation.sessionToken) {
    throw new Error('Relay returned an incomplete allocation');
  }
  return allocation;
}

async function releaseOnRelay(sessionToken: string): Promise<void> {
  const config = loadConfig();
  await safeFetch(`${config.RELAY_ENDPOINT}/v1/allocations/${encodeURIComponent(sessionToken)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${config.RELAY_TOKEN}` },
    timeoutMs: 8000,
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Data plane                                                          */
/* ------------------------------------------------------------------ */

function buildHeader(type: PacketType, clientId: number, sequence: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(MAGIC, 0);
  header.writeUInt8(VERSION, 1);
  header.writeUInt8(type, 2);
  header.writeUInt8(0, 3);
  header.writeUInt32BE(clientId >>> 0, 4);
  header.writeUInt32BE(sequence >>> 0, 8);
  return header;
}

function parseHeader(
  packet: Buffer,
): { type: PacketType; clientId: number; sequence: number } | null {
  if (packet.length < HEADER_BYTES) return null;
  if (packet.readUInt8(0) !== MAGIC) return null;
  if (packet.readUInt8(1) !== VERSION) return null;

  const type = packet.readUInt8(2);
  if (type < 1 || type > 5) return null;

  return {
    type: type as PacketType,
    clientId: packet.readUInt32BE(4),
    sequence: packet.readUInt32BE(8),
  };
}

/** HMAC over the session token proves this node owns the allocation. */
function buildAuthPayload(sessionToken: string, serverId: string): Buffer {
  const config = loadConfig();
  const mac = createHmac('sha256', config.RELAY_TOKEN!)
    .update(`${sessionToken}|${serverId}`)
    .digest();
  return Buffer.concat([Buffer.from(sessionToken, 'utf8'), Buffer.from([0]), mac]);
}

export async function openRelayTunnel(params: {
  serverId: string;
  portKey: string;
  localPort: number;
  protocol: 'udp' | 'tcp';
}): Promise<RelayTunnelResult> {
  if (!isRelayConfigured()) {
    return {
      success: false,
      publicHost: '',
      remotePort: 0,
      message: 'Relay mode is not configured on this node.',
    };
  }

  const key = tunnelKey(params.serverId, params.portKey);
  const existing = tunnels.get(key);
  if (existing && !existing.closed) {
    return {
      success: true,
      publicHost: '',
      remotePort: existing.remotePort,
      message: 'Relay tunnel already open.',
    };
  }

  let allocation: RelayAllocation;
  try {
    allocation = await allocateOnRelay(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Relay allocation failed';
    logger.warn({ err: error, serverId: params.serverId }, 'Relay allocation failed');
    return { success: false, publicHost: '', remotePort: 0, message };
  }

  try {
    const tunnel = await establishDataPlane(params, allocation);
    tunnels.set(key, tunnel);

    logger.info(
      { serverId: params.serverId, portKey: params.portKey, remotePort: allocation.publicPort },
      'Relay tunnel established',
    );

    return {
      success: true,
      publicHost: allocation.publicHost,
      remotePort: allocation.publicPort,
      message: 'Relay tunnel established.',
    };
  } catch (error) {
    await releaseOnRelay(allocation.sessionToken);
    const message = error instanceof Error ? error.message : 'Relay handshake failed';
    return { success: false, publicHost: '', remotePort: 0, message };
  }
}

async function establishDataPlane(
  params: { serverId: string; portKey: string; localPort: number },
  allocation: RelayAllocation,
): Promise<ActiveTunnel> {
  const socket = createSocket('udp4');

  const tunnel: ActiveTunnel = {
    serverId: params.serverId,
    portKey: params.portKey,
    socket,
    keepalive: setInterval(() => undefined, 1 << 30),
    sessionToken: allocation.sessionToken,
    remotePort: allocation.publicPort,
    localPort: params.localPort,
    clients: new Map(),
    sequence: 0,
    closed: false,
  };
  clearInterval(tunnel.keepalive);

  // --- Authenticate ---
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onAuth);
      reject(new Error('Relay did not acknowledge the session'));
    }, 8000);

    const onAuth = (message: Buffer): void => {
      const header = parseHeader(message);
      if (!header) return;
      if (header.type === 4) {
        clearTimeout(timer);
        socket.off('message', onAuth);
        resolve();
        return;
      }
      if (header.type === 5) {
        clearTimeout(timer);
        socket.off('message', onAuth);
        reject(new Error(message.subarray(HEADER_BYTES).toString('utf8').slice(0, 200)));
      }
    };

    socket.on('message', onAuth);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const authPacket = Buffer.concat([
      buildHeader(3, 0, 0),
      buildAuthPayload(allocation.sessionToken, params.serverId),
    ]);
    socket.send(authPacket, allocation.dataPort, allocation.dataHost, (error) => {
      if (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  // --- Forward relay -> local game server, and back ---
  socket.on('message', (packet) => {
    if (tunnel.closed) return;
    const header = parseHeader(packet);
    if (!header || header.type !== 1) return;

    const payload = packet.subarray(HEADER_BYTES);
    if (payload.length === 0 || payload.length > MAX_DATAGRAM) return;

    // Bound the client table so a spoofed flood cannot exhaust memory.
    if (!tunnel.clients.has(header.clientId) && tunnel.clients.size >= MAX_CLIENTS) {
      pruneClients(tunnel);
      if (tunnel.clients.size >= MAX_CLIENTS) return;
    }
    tunnel.clients.set(header.clientId, Date.now());

    const forwarder = createSocket('udp4');
    forwarder.send(payload, tunnel.localPort, '127.0.0.1', (error) => {
      if (error) {
        forwarder.close();
        return;
      }
    });

    // The game's reply comes back on this ephemeral socket; wrap and return it.
    const replyTimer = setTimeout(() => {
      try {
        forwarder.close();
      } catch {
        // already closed
      }
    }, 8000);
    replyTimer.unref();

    forwarder.on('message', (reply) => {
      if (tunnel.closed || reply.length > MAX_DATAGRAM) return;
      const wrapped = Buffer.concat([
        buildHeader(1, header.clientId, tunnel.sequence++ >>> 0),
        reply,
      ]);
      socket.send(wrapped, allocation.dataPort, allocation.dataHost, () => undefined);
    });
    forwarder.on('error', () => {
      clearTimeout(replyTimer);
      try {
        forwarder.close();
      } catch {
        // already closed
      }
    });
  });

  socket.on('error', (error) => {
    logger.warn({ err: error, serverId: params.serverId }, 'Relay data socket error');
  });

  tunnel.keepalive = setInterval(() => {
    if (tunnel.closed) return;
    socket.send(
      buildHeader(2, 0, tunnel.sequence++ >>> 0),
      allocation.dataPort,
      allocation.dataHost,
      () => undefined,
    );
    pruneClients(tunnel);
  }, KEEPALIVE_MS);
  tunnel.keepalive.unref();

  return tunnel;
}

function pruneClients(tunnel: ActiveTunnel): void {
  const cutoff = Date.now() - CLIENT_IDLE_MS;
  for (const [clientId, lastSeen] of tunnel.clients) {
    if (lastSeen < cutoff) tunnel.clients.delete(clientId);
  }
}

export async function closeRelayTunnel(serverId: string, portKey: string): Promise<void> {
  const key = tunnelKey(serverId, portKey);
  const tunnel = tunnels.get(key);
  if (!tunnel) return;

  tunnel.closed = true;
  clearInterval(tunnel.keepalive);
  try {
    tunnel.socket.close();
  } catch {
    // already closed
  }
  tunnels.delete(key);
  await releaseOnRelay(tunnel.sessionToken);

  logger.info({ serverId, portKey }, 'Relay tunnel closed');
}

export async function closeAllRelayTunnels(): Promise<void> {
  await Promise.all(
    [...tunnels.values()].map((tunnel) => closeRelayTunnel(tunnel.serverId, tunnel.portKey)),
  );
}

export function relayTunnelCount(): number {
  return tunnels.size;
}

/** Constant-time token comparison, used by the relay daemon build. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
