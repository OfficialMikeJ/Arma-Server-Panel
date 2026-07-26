/**
 * Deriving a trustworthy client identity.
 *
 * X-Forwarded-For is attacker-controlled unless every hop that set it is one we
 * operate. The panel therefore only honours forwarded headers when the socket
 * peer is inside an explicitly configured proxy CIDR, and walks the chain from
 * the right so a spoofed prefix cannot win.
 */

import type { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { loadConfig } from '../config/env.js';
import { pepperedHash } from './crypto.js';

interface ParsedCidr {
  base: bigint;
  mask: bigint;
  bits: number;
  version: 4 | 6;
}

function ipToBigInt(ip: string): { value: bigint; version: 4 | 6 } | null {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    let value = 0n;
    for (const part of parts) value = (value << 8n) | BigInt(part);
    return { value, version: 4 };
  }
  if (version === 6) {
    const normalized = expandIpv6(ip);
    if (!normalized) return null;
    let value = 0n;
    for (const group of normalized) value = (value << 16n) | BigInt(group);
    return { value, version: 6 };
  }
  return null;
}

function expandIpv6(ip: string): number[] | null {
  const stripped = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? ip;
  // IPv4-mapped form, e.g. ::ffff:203.0.113.5
  const v4Match = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(stripped);
  let work = stripped;
  if (v4Match) {
    const octets = v4Match[2]!.split('.').map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    work = `${v4Match[1]}${hi}:${lo}`;
  }

  const halves = work.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const fillCount = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fillCount < 0) return null;

  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? fillCount : 0).fill('0'),
    ...tail,
  ];
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, bitsRaw] = cidr.split('/');
  if (!addr) return null;
  const parsed = ipToBigInt(addr);
  if (!parsed) return null;
  const totalBits = parsed.version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? totalBits : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > totalBits) return null;

  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(totalBits - bits);
  return { base: parsed.value & mask, mask, bits, version: parsed.version };
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsedCidr = parseCidr(cidr);
  const parsedIp = ipToBigInt(ip);
  if (!parsedCidr || !parsedIp) return false;
  if (parsedCidr.version !== parsedIp.version) return false;
  return (parsedIp.value & parsedCidr.mask) === parsedCidr.base;
}

export function ipInAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}

/** Private, loopback, link-local and other non-routable ranges. */
const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
  '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '100::/64',
  '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8',
];

export function isPrivateAddress(ip: string): boolean {
  return ipInAnyCidr(ip, PRIVATE_RANGES);
}

/**
 * Resolves the real client address.
 *
 * Returns the socket peer unless TRUST_PROXY is on *and* the peer is a
 * configured proxy, in which case the right-most untrusted entry of
 * X-Forwarded-For is used.
 */
export function resolveClientIp(request: FastifyRequest): string {
  const config = loadConfig();
  const socketIp = request.socket.remoteAddress ?? '0.0.0.0';

  if (!config.TRUST_PROXY || config.trustedProxyCidrs.length === 0) {
    return normalizeIp(socketIp);
  }
  if (!ipInAnyCidr(normalizeIp(socketIp), config.trustedProxyCidrs)) {
    // Direct connection from someone pretending to be behind our proxy.
    return normalizeIp(socketIp);
  }

  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return normalizeIp(socketIp);

  const chain = raw.split(',').map((s) => normalizeIp(s.trim())).filter((s) => isIP(s) !== 0);
  // Walk right-to-left; the first address that is not one of our proxies is
  // the closest thing to a real client we can prove.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const candidate = chain[i]!;
    if (!ipInAnyCidr(candidate, config.trustedProxyCidrs)) return candidate;
  }
  return normalizeIp(socketIp);
}

export function normalizeIp(ip: string): string {
  const stripped = ip.replace(/^\[|\]$/g, '');
  // Node reports IPv4 peers as ::ffff:a.b.c.d when listening on a dual stack.
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(stripped);
  return mapped ? mapped[1]! : stripped;
}

export interface ClientIdentity {
  ip: string;
  ipHash: string;
  userAgent: string;
  userAgentHash: string;
  /** Stable identifier for abuse tracking: IP plus optional external identity. */
  clientHash: string;
}

export function getClientIdentity(request: FastifyRequest, externalId?: string | null): ClientIdentity {
  const ip = resolveClientIp(request);
  const rawUa = request.headers['user-agent'] ?? '';
  const userAgent = (Array.isArray(rawUa) ? rawUa[0]! : rawUa).slice(0, 512);

  return {
    ip,
    ipHash: pepperedHash(ip, 'ip'),
    userAgent,
    userAgentHash: pepperedHash(userAgent, 'ua'),
    clientHash: pepperedHash(externalId ? `${ip}|${externalId}` : ip, 'client'),
  };
}
