/**
 * Automatic port forwarding.
 *
 * Three protocols are implemented directly, tried in order of reliability:
 *
 *   1. NAT-PMP  (RFC 6886) - Apple/older routers. Tiny binary UDP protocol.
 *   2. PCP      (RFC 6887) - NAT-PMP's successor, on most modern firmware.
 *   3. UPnP IGD (SSDP discovery + SOAP) - widest support, most often disabled.
 *
 * None of this applies to a host that already holds a public address - a VPS, a
 * dedicated or colocated machine, or a home lab on a routed prefix. There is no
 * NAT to traverse there, so `probeNatEnvironment` detects that case first and
 * returns immediately rather than spending seconds on SSDP discovery and then
 * telling the operator to configure a router they do not have.
 *
 * Honest limitation, and why the relay exists:
 *   No port-mapping protocol can work when the ISP places the customer behind
 *   carrier-grade NAT, or when the router has UPnP/NAT-PMP disabled and the
 *   customer will not enable it. In those cases nothing running on the LAN can
 *   open an inbound port - that is a property of the network, not of this code.
 *   `port-forwarder.ts` therefore falls through to a relay tunnel, which
 *   reaches 100% of hosts *and* is the only option that keeps a residential IP
 *   private, since with a direct mapping players see the real address by
 *   definition.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '../../lib/logger.js';
import { loadConfig } from '../../config/env.js';
import { ipInAnyCidr, isPrivateAddress } from '../../security/client-identity.js';

export type Protocol = 'udp' | 'tcp';

export interface MappingRequest {
  internalPort: number;
  externalPort: number;
  protocol: Protocol;
  /** Seconds. 0 requests the longest lease the device will grant. */
  leaseSeconds: number;
  description: string;
}

export interface MappingResult {
  success: boolean;
  method: 'natpmp' | 'pcp' | 'upnp';
  externalPort: number;
  externalAddress: string | null;
  leaseSeconds: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Gateway discovery                                                   */
/* ------------------------------------------------------------------ */

/**
 * Best-effort default gateway detection without shelling out.
 *
 * Derives the likely gateway from each non-loopback IPv4 interface by taking
 * the network address + 1, which is the convention on essentially every
 * consumer router. Candidates are probed, so a wrong guess simply times out.
 */
/** Docker's default bridge pools. Addresses here belong to a container, not the host. */
const DOCKER_RANGES = ['172.16.0.0/12', '10.0.0.0/8'];

/**
 * True when the only addresses visible are Docker bridge addresses.
 *
 * A bridged container cannot see the LAN, so anything derived from its own
 * interfaces describes Docker's network, not the machine's. Detecting this is
 * the difference between "your router refused" and "we asked the wrong thing".
 */
export function isContainerNetwork(): boolean {
  const addresses: string[] = [];

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }

  if (addresses.length === 0) return false;

  // Docker bridges are 172.17-172.31 by default; a real LAN is usually
  // 192.168.x or 10.x. If nothing outside the docker pool is visible, we are
  // almost certainly inside a container.
  return addresses.every(
    (address) => ipInAnyCidr(address, DOCKER_RANGES) && address.startsWith('172.'),
  );
}

export function guessGateways(): string[] {
  const config = loadConfig();
  const candidates = new Set<string>();

  // An explicit router address always wins: inside a container it is the only
  // way to reach the real one, and outside it saves a round of guessing.
  if (config.ROUTER_ADDRESS) candidates.add(config.ROUTER_ADDRESS);

  // If the operator told us the host's LAN address, derive its gateway too.
  if (config.LAN_ADDRESS) {
    const parts = config.LAN_ADDRESS.split('.').map(Number);
    if (parts.length === 4 && parts.every((p) => Number.isInteger(p))) {
      candidates.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
    }
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isPrivateAddress(address.address)) continue;
      // Skip Docker bridges - their gateway is dockerd, which forwards nothing.
      if (address.address.startsWith('172.') && ipInAnyCidr(address.address, DOCKER_RANGES)) {
        continue;
      }

      const ipParts = address.address.split('.').map(Number);
      const maskParts = address.netmask.split('.').map(Number);
      if (ipParts.length !== 4 || maskParts.length !== 4) continue;

      const network = ipParts.map((part, i) => part & (maskParts[i] ?? 255));
      network[3] = (network[3] ?? 0) + 1;
      candidates.add(network.join('.'));
    }
  }

  // Common defaults, in case interface enumeration was unhelpful.
  for (const fallback of ['192.168.1.1', '192.168.0.1', '10.0.0.1']) {
    candidates.add(fallback);
  }

  return [...candidates];
}

/**
 * The address a port mapping should point at.
 *
 * Must be the *host's* LAN address, since that is where Docker publishes the
 * port. The container's own address is unroutable from the router.
 */
export function getLocalAddress(): string | null {
  const config = loadConfig();
  if (config.LAN_ADDRESS) return config.LAN_ADDRESS;

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isPrivateAddress(address.address)) continue;
      // A container address here would produce a mapping to nowhere.
      if (address.address.startsWith('172.') && ipInAnyCidr(address.address, DOCKER_RANGES)) {
        continue;
      }
      return address.address;
    }
  }
  return null;
}

async function udpExchange(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;

    const finish = (result: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (message) => finish(message));
    socket.send(payload, port, host, (error) => {
      if (error) finish(null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* NAT-PMP (RFC 6886)                                                  */
/* ------------------------------------------------------------------ */

const NATPMP_PORT = 5351;

const NATPMP_RESULT_MESSAGES: Record<number, string> = {
  0: 'Success',
  1: 'Unsupported protocol version',
  2: 'Not authorised (port mapping is disabled on the router)',
  3: 'Network failure',
  4: 'Out of resources',
  5: 'Unsupported opcode',
};

export async function natpmpExternalAddress(gateway: string): Promise<string | null> {
  const request = Buffer.from([0, 0]); // version 0, opcode 0
  const response = await udpExchange(gateway, NATPMP_PORT, request, 1500);
  if (!response || response.length < 12) return null;
  if (response[0] !== 0 || response[1] !== 128) return null;
  if (response.readUInt16BE(2) !== 0) return null;
  return `${response[8]}.${response[9]}.${response[10]}.${response[11]}`;
}

export async function natpmpMap(
  gateway: string,
  request: MappingRequest,
): Promise<MappingResult | null> {
  // opcode 1 = UDP, 2 = TCP
  const opcode = request.protocol === 'udp' ? 1 : 2;
  const packet = Buffer.alloc(12);
  packet.writeUInt8(0, 0); // version
  packet.writeUInt8(opcode, 1);
  packet.writeUInt16BE(0, 2); // reserved
  packet.writeUInt16BE(request.internalPort, 4);
  packet.writeUInt16BE(request.externalPort, 6);
  packet.writeUInt32BE(request.leaseSeconds || 3600, 8);

  const response = await udpExchange(gateway, NATPMP_PORT, packet, 2000);
  if (!response || response.length < 16) return null;

  const resultCode = response.readUInt16BE(2);
  if (resultCode !== 0) {
    return {
      success: false,
      method: 'natpmp',
      externalPort: request.externalPort,
      externalAddress: null,
      leaseSeconds: 0,
      message: NATPMP_RESULT_MESSAGES[resultCode] ?? `NAT-PMP error ${resultCode}`,
    };
  }

  const externalPort = response.readUInt16BE(10);
  const lease = response.readUInt32BE(12);
  const externalAddress = await natpmpExternalAddress(gateway);

  return {
    success: true,
    method: 'natpmp',
    externalPort,
    externalAddress,
    leaseSeconds: lease,
    message: 'Mapped via NAT-PMP',
  };
}

export async function natpmpUnmap(gateway: string, request: MappingRequest): Promise<boolean> {
  // A lease of 0 with external port 0 deletes the mapping.
  const result = await natpmpMap(gateway, { ...request, externalPort: 0, leaseSeconds: 0 });
  return result?.success ?? false;
}

/* ------------------------------------------------------------------ */
/* PCP (RFC 6887)                                                      */
/* ------------------------------------------------------------------ */

const PCP_PORT = 5351;
const PCP_VERSION = 2;
const PCP_OPCODE_MAP = 1;

const PCP_RESULT_MESSAGES: Record<number, string> = {
  0: 'Success',
  1: 'Unsupported version',
  2: 'Not authorised (port mapping is disabled on the router)',
  3: 'Malformed request',
  4: 'Unsupported opcode',
  8: 'No resources',
  9: 'Unsupported protocol',
  10: 'User exceeded quota',
  11: 'Cannot provide external port',
};

/** Encodes an IPv4 address as an IPv4-mapped IPv6 address, as PCP requires. */
function toMappedIpv6(ipv4: string): Buffer {
  const buffer = Buffer.alloc(16);
  buffer[10] = 0xff;
  buffer[11] = 0xff;
  const octets = ipv4.split('.').map(Number);
  buffer[12] = octets[0] ?? 0;
  buffer[13] = octets[1] ?? 0;
  buffer[14] = octets[2] ?? 0;
  buffer[15] = octets[3] ?? 0;
  return buffer;
}

export async function pcpMap(
  gateway: string,
  request: MappingRequest,
  localAddress: string,
): Promise<MappingResult | null> {
  const nonce = Buffer.alloc(12);
  // Deterministic per (port, protocol) so a renewal targets the same mapping.
  nonce.writeUInt16BE(request.internalPort, 0);
  nonce.writeUInt8(request.protocol === 'udp' ? 17 : 6, 2);
  nonce.write('ASPMAP', 3, 'ascii');

  const packet = Buffer.alloc(60);
  packet.writeUInt8(PCP_VERSION, 0);
  packet.writeUInt8(PCP_OPCODE_MAP, 1); // R=0 (request)
  packet.writeUInt16BE(0, 2); // reserved
  packet.writeUInt32BE(request.leaseSeconds || 3600, 4);
  toMappedIpv6(localAddress).copy(packet, 8);
  nonce.copy(packet, 24);
  packet.writeUInt8(request.protocol === 'udp' ? 17 : 6, 36); // IANA protocol
  packet.writeUInt8(0, 37);
  packet.writeUInt16BE(0, 38);
  packet.writeUInt16BE(request.internalPort, 40);
  packet.writeUInt16BE(request.externalPort, 42);
  toMappedIpv6('0.0.0.0').copy(packet, 44);

  const response = await udpExchange(gateway, PCP_PORT, packet, 2000);
  if (!response || response.length < 60) return null;
  if (response.readUInt8(0) !== PCP_VERSION) return null;

  const resultCode = response.readUInt8(3);
  if (resultCode !== 0) {
    return {
      success: false,
      method: 'pcp',
      externalPort: request.externalPort,
      externalAddress: null,
      leaseSeconds: 0,
      message: PCP_RESULT_MESSAGES[resultCode] ?? `PCP error ${resultCode}`,
    };
  }

  const lifetime = response.readUInt32BE(4);
  const assignedExternalPort = response.readUInt16BE(42);
  const externalIpBytes = response.subarray(56, 60);
  const externalAddress = `${externalIpBytes[0]}.${externalIpBytes[1]}.${externalIpBytes[2]}.${externalIpBytes[3]}`;

  return {
    success: true,
    method: 'pcp',
    externalPort: assignedExternalPort,
    externalAddress: externalAddress === '0.0.0.0' ? null : externalAddress,
    leaseSeconds: lifetime,
    message: 'Mapped via PCP',
  };
}

/* ------------------------------------------------------------------ */
/* UPnP IGD                                                            */
/* ------------------------------------------------------------------ */

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

const IGD_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export interface IgdDevice {
  /** Base URL of the device description document. */
  location: string;
  /** Absolute control URL of the WAN connection service. */
  controlUrl: string;
  serviceType: string;
}

/** SSDP M-SEARCH. Returns every device that answers within the window. */
async function discoverIgdLocations(timeoutMs = 3000): Promise<string[]> {
  const locations = new Set<string>();
  const socket = createSocket({ type: 'udp4', reuseAddr: true });

  await new Promise<void>((resolve) => {
    socket.on('error', () => resolve());
    socket.on('message', (message) => {
      const text = message.toString('ascii');
      const match = /^LOCATION:\s*(\S+)/im.exec(text);
      if (match?.[1]) locations.add(match[1]);
    });

    socket.bind(() => {
      for (const target of IGD_SEARCH_TARGETS) {
        const query = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${target}`,
          '',
          '',
        ].join('\r\n');
        socket.send(Buffer.from(query, 'ascii'), SSDP_PORT, SSDP_ADDRESS, () => undefined);
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve();
      }, timeoutMs);
    });
  });

  return [...locations];
}

/**
 * Fetches a device description.
 *
 * This talks to a LAN address, so the SSRF guard that blocks private
 * addresses cannot be used. The exposure is bounded instead: only http, only
 * a private address, a hard size cap, and a short timeout.
 */
async function fetchDeviceDescription(location: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:') return null;
  if (!isPrivateAddress(url.hostname)) {
    logger.warn({ location }, 'Ignoring UPnP device outside the local network');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return null;

    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > 512 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveControlUrl(description: string, location: string): IgdDevice | null {
  // Deliberately not a full XML parse: an XML parser fed a hostile document is
  // an XXE risk. A targeted regex over a document we already size-capped is
  // both sufficient and safer here.
  const serviceBlocks = description.match(/<service>[\s\S]*?<\/service>/gi) ?? [];

  for (const wanted of [
    'urn:schemas-upnp-org:service:WANIPConnection:2',
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'urn:schemas-upnp-org:service:WANPPPConnection:1',
  ]) {
    for (const block of serviceBlocks) {
      if (!block.includes(wanted)) continue;
      const controlMatch = /<controlURL>([^<]+)<\/controlURL>/i.exec(block);
      if (!controlMatch?.[1]) continue;
      try {
        return {
          location,
          controlUrl: new URL(controlMatch[1].trim(), location).toString(),
          serviceType: wanted,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function discoverIgd(): Promise<IgdDevice | null> {
  const config = loadConfig();

  // SSDP is multicast and cannot leave a bridged container, so an explicit
  // control URL is the only way to use UPnP from inside one.
  if (config.UPNP_CONTROL_URL) {
    try {
      const url = new URL(config.UPNP_CONTROL_URL);
      logger.info({ controlUrl: url.toString() }, 'Using the configured UPnP control URL');
      return {
        location: url.origin,
        controlUrl: url.toString(),
        serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
      };
    } catch {
      logger.warn('UPNP_CONTROL_URL is not a valid URL; ignoring it');
    }
  }

  if (isContainerNetwork()) {
    logger.info(
      'Skipping SSDP discovery: multicast cannot leave a bridged container. ' +
        'Set UPNP_CONTROL_URL to use UPnP from here.',
    );
    return null;
  }

  const locations = await discoverIgdLocations();
  for (const location of locations) {
    const description = await fetchDeviceDescription(location);
    if (!description) continue;
    const device = resolveControlUrl(description, location);
    if (device) {
      logger.info({ controlUrl: device.controlUrl }, 'Discovered UPnP IGD');
      return device;
    }
  }
  return null;
}

/** Escapes text for inclusion in a SOAP body. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

async function soapCall(
  device: IgdDevice,
  action: string,
  args: Array<[string, string]>,
): Promise<string | null> {
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${device.serviceType}">` +
    args.map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(device.controlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: `"${device.serviceType}#${action}"`,
      },
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    return response.ok ? text : `ERROR:${response.status}:${text.slice(0, 500)}`;
  } catch (error) {
    logger.debug({ err: error, action }, 'UPnP SOAP call failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function upnpMap(
  device: IgdDevice,
  request: MappingRequest,
  localAddress: string,
): Promise<MappingResult> {
  const result = await soapCall(device, 'AddPortMapping', [
    ['NewRemoteHost', ''],
    ['NewExternalPort', String(request.externalPort)],
    ['NewProtocol', request.protocol.toUpperCase()],
    ['NewInternalPort', String(request.internalPort)],
    ['NewInternalClient', localAddress],
    ['NewEnabled', '1'],
    ['NewPortMappingDescription', request.description.slice(0, 64)],
    ['NewLeaseDuration', String(request.leaseSeconds)],
  ]);

  if (result === null) {
    return {
      success: false,
      method: 'upnp',
      externalPort: request.externalPort,
      externalAddress: null,
      leaseSeconds: 0,
      message: 'The router did not respond to the UPnP request.',
    };
  }

  if (result.startsWith('ERROR:')) {
    // 725 = OnlyPermanentLeasesSupported. Retry with a permanent mapping.
    if (result.includes('725') && request.leaseSeconds !== 0) {
      return upnpMap(device, { ...request, leaseSeconds: 0 }, localAddress);
    }
    // 718 = ConflictInMappingEntry.
    const message = result.includes('718')
      ? 'That external port is already mapped to a different device on the router.'
      : result.includes('606')
        ? 'The router refused the request (action not authorised).'
        : 'The router rejected the UPnP request.';
    return {
      success: false,
      method: 'upnp',
      externalPort: request.externalPort,
      externalAddress: null,
      leaseSeconds: 0,
      message,
    };
  }

  const externalAddress = await upnpExternalAddress(device);

  return {
    success: true,
    method: 'upnp',
    externalPort: request.externalPort,
    externalAddress,
    leaseSeconds: request.leaseSeconds,
    message: 'Mapped via UPnP',
  };
}

export async function upnpUnmap(device: IgdDevice, request: MappingRequest): Promise<boolean> {
  const result = await soapCall(device, 'DeletePortMapping', [
    ['NewRemoteHost', ''],
    ['NewExternalPort', String(request.externalPort)],
    ['NewProtocol', request.protocol.toUpperCase()],
  ]);
  return result !== null && !result.startsWith('ERROR:');
}

export async function upnpExternalAddress(device: IgdDevice): Promise<string | null> {
  const result = await soapCall(device, 'GetExternalIPAddress', []);
  if (!result || result.startsWith('ERROR:')) return null;
  const match = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(result);
  const address = match?.[1]?.trim();
  return address && address !== '0.0.0.0' ? address : null;
}

/* ------------------------------------------------------------------ */
/* Diagnosis                                                           */
/* ------------------------------------------------------------------ */

export interface NatEnvironment {
  localAddress: string | null;
  gateway: string | null;
  externalAddress: string | null;
  natpmpAvailable: boolean;
  pcpAvailable: boolean;
  upnpAvailable: boolean;
  upnpDevice: IgdDevice | null;
  /** True when the WAN address is itself private - i.e. carrier-grade NAT. */
  behindCgnat: boolean;
  /**
   * True when this machine holds a public address itself, with no NAT in front
   * of it - a VPS, a dedicated server, a colocated box, or a home lab on a
   * routed prefix.
   *
   * There is nothing to traverse in that case. Asking for a router, probing for
   * NAT-PMP and then reporting "automatic port opening did not succeed" is not
   * a failure to report: the port is already open, subject only to the host's
   * own firewall.
   */
  directPublic: boolean;
  /** Running in a container that cannot see the LAN by itself. */
  containerised: boolean;
  /** Set when configuration is missing and nothing can possibly work. */
  configurationProblem: string | null;
}

/**
 * Whether this host sits directly on a public address.
 *
 * Checks the address the operator told us about first, then the machine's own
 * interfaces - a bare-metal install in a data centre has the public address on
 * eth0 and no LAN_ADDRESS set at all.
 */
export function hasDirectPublicAddress(): boolean {
  const config = loadConfig();
  if (config.LAN_ADDRESS) return !isPrivateAddress(config.LAN_ADDRESS);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isPrivateAddress(address.address)) return true;
    }
  }
  return false;
}

/**
 * Probes what the network actually supports. Run once per node and cached,
 * because SSDP discovery is slow.
 */
export async function probeNatEnvironment(): Promise<NatEnvironment> {
  const config = loadConfig();
  const containerised = isContainerNetwork();
  const localAddress = getLocalAddress();
  const gateways = guessGateways();
  const directPublic = hasDirectPublicAddress();

  // A host on a public address has no NAT to traverse. Skip the whole probe -
  // it would spend seconds on SSDP discovery, find nothing, and then tell a
  // data-centre operator to configure a router they do not have.
  if (directPublic) {
    return {
      localAddress,
      gateway: null,
      externalAddress: config.LAN_ADDRESS ?? localAddress,
      natpmpAvailable: false,
      pcpAvailable: false,
      upnpAvailable: false,
      upnpDevice: null,
      behindCgnat: false,
      directPublic: true,
      containerised,
      configurationProblem: null,
    };
  }

  // Bail early with something actionable rather than probing Docker's bridge
  // and reporting "no gateway found", which sounds like a router fault.
  if (containerised && (!config.LAN_ADDRESS || !config.ROUTER_ADDRESS)) {
    const missing = [
      !config.LAN_ADDRESS ? 'LAN_ADDRESS' : null,
      !config.ROUTER_ADDRESS ? 'ROUTER_ADDRESS' : null,
    ].filter(Boolean);

    return {
      localAddress,
      gateway: null,
      externalAddress: null,
      natpmpAvailable: false,
      pcpAvailable: false,
      upnpAvailable: false,
      upnpDevice: null,
      behindCgnat: false,
      directPublic: false,
      containerised: true,
      configurationProblem:
        `The panel runs in a container and cannot see your LAN by itself. ` +
        `Set ${missing.join(' and ')} in .env — ` +
        `LAN_ADDRESS is this machine's address (the one you browse the panel on), ` +
        `ROUTER_ADDRESS is your router's.`,
    };
  }

  let gateway: string | null = null;
  let externalAddress: string | null = null;
  let natpmpAvailable = false;

  for (const candidate of gateways) {
    const address = await natpmpExternalAddress(candidate);
    if (address) {
      gateway = candidate;
      externalAddress = address;
      natpmpAvailable = true;
      break;
    }
  }

  // PCP shares NAT-PMP's port; probe it separately with a zero-lease request.
  let pcpAvailable = false;
  if (localAddress) {
    for (const candidate of gateway ? [gateway] : gateways.slice(0, 4)) {
      const probe = await pcpMap(
        candidate,
        {
          internalPort: 0,
          externalPort: 0,
          protocol: 'udp',
          leaseSeconds: 0,
          description: 'probe',
        },
        localAddress,
      );
      if (probe !== null) {
        pcpAvailable = true;
        gateway ??= candidate;
        externalAddress ??= probe.externalAddress;
        break;
      }
      await delay(50);
    }
  }

  const upnpDevice = await discoverIgd();
  if (upnpDevice && !externalAddress) {
    externalAddress = await upnpExternalAddress(upnpDevice);
  }

  return {
    localAddress,
    gateway,
    externalAddress,
    natpmpAvailable,
    pcpAvailable,
    upnpAvailable: upnpDevice !== null,
    upnpDevice,
    // A private WAN address means the ISP is doing the NAT, and no
    // LAN-side protocol can open a port through it.
    behindCgnat: externalAddress !== null && isPrivateAddress(externalAddress),
    directPublic: false,
    containerised,
    configurationProblem:
      localAddress === null
        ? 'Could not determine this machine’s LAN address. Set LAN_ADDRESS in .env.'
        : null,
  };
}
