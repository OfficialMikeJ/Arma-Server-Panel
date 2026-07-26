/**
 * Port exposure strategy.
 *
 * Goal from the spec: a server must be reachable from the public internet, and
 * a self-hoster's home IP must not be exposed.
 *
 * Those two goals conflict under direct port forwarding - if players connect
 * straight to the router, they can see its address. The panel therefore treats
 * relay mode as the *preferred* path, not the fallback:
 *
 *   relay  -> reachable AND private. Works behind CGNAT. Requires a relay host.
 *   natpmp -> reachable, address visible. No relay needed.
 *   pcp    -> same.
 *   upnp   -> same.
 *   manual -> instructions for the operator when nothing automatic works.
 *
 * `auto` picks relay when one is configured, otherwise walks the automatic
 * protocols in order and reports honestly if none succeed.
 */

import { PortMethod } from '@prisma/client';
import { GAMES, type GameId } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../../security/audit.js';
import {
  natpmpMap,
  natpmpUnmap,
  pcpMap,
  probeNatEnvironment,
  upnpMap,
  upnpUnmap,
  type IgdDevice,
  type MappingRequest,
  type NatEnvironment,
} from './nat-traversal.js';
import { openRelayTunnel, closeRelayTunnel, isRelayConfigured } from './relay.js';

export type PreferredMethod = 'auto' | 'upnp' | 'natpmp' | 'pcp' | 'relay' | 'manual';

export interface ForwardOutcome {
  portKey: string;
  protocol: 'udp' | 'tcp';
  internalPort: number;
  externalPort: number;
  method: PortMethod;
  success: boolean;
  /** Address players should use. Never the home IP when relay mode is active. */
  publicHost: string | null;
  leaseSeconds: number | null;
  message: string;
  /** True when the operator's own IP is visible to players. */
  exposesHostIp: boolean;
}

let cachedEnvironment: NatEnvironment | null = null;
let cachedAt = 0;
const ENVIRONMENT_TTL_MS = 10 * 60 * 1000;

export async function getNatEnvironment(force = false): Promise<NatEnvironment> {
  if (!force && cachedEnvironment && Date.now() - cachedAt < ENVIRONMENT_TTL_MS) {
    return cachedEnvironment;
  }
  cachedEnvironment = await probeNatEnvironment();
  cachedAt = Date.now();
  return cachedEnvironment;
}

export interface ForwardRequest {
  serverId: string;
  preferred: PreferredMethod;
  leaseSeconds: number;
  actor: { accountId: string; username: string; ipHash: string; userAgentHash: string };
}

export async function forwardServerPorts(request: ForwardRequest): Promise<ForwardOutcome[]> {
  const server = await prisma.server.findFirst({
    where: { id: request.serverId, deletedAt: null },
    include: { ports: true, node: true },
  });
  if (!server) throw new Error('Server not found');

  // Only ports the game definition marks public are ever opened. RCON is
  // never published, regardless of what the caller asks for.
  const publicPorts = server.ports.filter((p) => isPublicPortKey(p.portKey, server.game));
  const environment = await getNatEnvironment();
  const outcomes: ForwardOutcome[] = [];

  for (const port of publicPorts) {
    const mapping: MappingRequest = {
      internalPort: port.internalPort,
      externalPort: port.externalPort,
      protocol: port.protocol as 'udp' | 'tcp',
      leaseSeconds: request.leaseSeconds,
      description: `ArmaServerPanel ${server.name.slice(0, 24)} ${port.portKey}`,
    };

    const outcome = await forwardSinglePort(mapping, port.portKey, request.preferred, environment, {
      serverId: server.id,
      relayEnabled: server.useRelay,
    });

    await prisma.portAllocation.update({
      where: { id: port.id },
      data: {
        method: outcome.method,
        active: outcome.success,
        leaseExpiresAt:
          outcome.success && outcome.leaseSeconds
            ? new Date(Date.now() + outcome.leaseSeconds * 1000)
            : null,
        message: outcome.message,
        lastVerifiedAt: new Date(),
      },
    });

    outcomes.push(outcome);
  }

  const anySuccess = outcomes.some((o) => o.success);
  const publicHost = outcomes.find((o) => o.success && o.publicHost)?.publicHost;

  if (publicHost) {
    await prisma.server.update({
      where: { id: server.id },
      data: { publicHost },
    });
  }

  await audit({
    accountId: request.actor.accountId,
    actorLabel: request.actor.username,
    action: anySuccess ? AuditAction.PortMappingCreated : AuditAction.PortMappingFailed,
    targetType: 'server',
    targetId: server.id,
    outcome: anySuccess ? 'success' : 'failure',
    ipHash: request.actor.ipHash,
    userAgentHash: request.actor.userAgentHash,
    metadata: {
      preferred: request.preferred,
      results: outcomes.map((o) => ({
        port: o.externalPort,
        method: o.method,
        success: o.success,
      })),
    },
  });

  return outcomes;
}

async function forwardSinglePort(
  mapping: MappingRequest,
  portKey: string,
  preferred: PreferredMethod,
  environment: NatEnvironment,
  context: { serverId: string; relayEnabled: boolean },
): Promise<ForwardOutcome> {
  const base = {
    portKey,
    protocol: mapping.protocol,
    internalPort: mapping.internalPort,
    externalPort: mapping.externalPort,
  };

  const wantsRelay =
    preferred === 'relay' || (preferred === 'auto' && (context.relayEnabled || isRelayConfigured()));

  /* ---- Relay: reachable and private ---- */
  if (wantsRelay && isRelayConfigured()) {
    const relay = await openRelayTunnel({
      serverId: context.serverId,
      portKey,
      localPort: mapping.externalPort,
      protocol: mapping.protocol,
    });

    if (relay.success) {
      return {
        ...base,
        externalPort: relay.remotePort,
        method: PortMethod.RELAY,
        success: true,
        publicHost: relay.publicHost,
        leaseSeconds: null,
        message: 'Reachable through the relay. Your own IP address is not visible to players.',
        exposesHostIp: false,
      };
    }

    if (preferred === 'relay') {
      return {
        ...base,
        method: PortMethod.RELAY,
        success: false,
        publicHost: null,
        leaseSeconds: null,
        message: relay.message,
        exposesHostIp: false,
      };
    }
    logger.warn({ portKey, reason: relay.message }, 'Relay unavailable, falling back to direct mapping');
  }

  /* ---- Carrier-grade NAT: nothing LAN-side can help ---- */
  if (environment.behindCgnat && preferred !== 'manual') {
    return {
      ...base,
      method: PortMethod.MANUAL,
      success: false,
      publicHost: null,
      leaseSeconds: null,
      message:
        'Your ISP places this connection behind carrier-grade NAT, so no router setting can open an inbound port. ' +
        'Enable relay mode, or ask your ISP for a public IPv4 address.',
      exposesHostIp: false,
    };
  }

  const order: Array<'natpmp' | 'pcp' | 'upnp'> =
    preferred === 'auto'
      ? ['natpmp', 'pcp', 'upnp']
      : preferred === 'manual' || preferred === 'relay'
        ? []
        : [preferred];

  const failures: string[] = [];

  for (const method of order) {
    try {
      if (method === 'natpmp') {
        if (!environment.gateway) {
          failures.push('NAT-PMP: no gateway found');
          continue;
        }
        const result = await natpmpMap(environment.gateway, mapping);
        if (result?.success) {
          return {
            ...base,
            externalPort: result.externalPort,
            method: PortMethod.NATPMP,
            success: true,
            publicHost: result.externalAddress,
            leaseSeconds: result.leaseSeconds,
            message: 'Port opened automatically via NAT-PMP.',
            exposesHostIp: true,
          };
        }
        failures.push(`NAT-PMP: ${result?.message ?? 'no response'}`);
      }

      if (method === 'pcp') {
        if (!environment.gateway || !environment.localAddress) {
          failures.push('PCP: no gateway found');
          continue;
        }
        const result = await pcpMap(environment.gateway, mapping, environment.localAddress);
        if (result?.success) {
          return {
            ...base,
            externalPort: result.externalPort,
            method: PortMethod.PCP,
            success: true,
            publicHost: result.externalAddress,
            leaseSeconds: result.leaseSeconds,
            message: 'Port opened automatically via PCP.',
            exposesHostIp: true,
          };
        }
        failures.push(`PCP: ${result?.message ?? 'no response'}`);
      }

      if (method === 'upnp') {
        const device: IgdDevice | null = environment.upnpDevice;
        if (!device || !environment.localAddress) {
          failures.push('UPnP: no gateway device found');
          continue;
        }
        const result = await upnpMap(device, mapping, environment.localAddress);
        if (result.success) {
          return {
            ...base,
            method: PortMethod.UPNP,
            success: true,
            publicHost: result.externalAddress,
            leaseSeconds: result.leaseSeconds || null,
            message: 'Port opened automatically via UPnP.',
            exposesHostIp: true,
          };
        }
        failures.push(`UPnP: ${result.message}`);
      }
    } catch (error) {
      failures.push(`${method}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  /* ---- Nothing automatic worked ---- */
  return {
    ...base,
    method: PortMethod.MANUAL,
    success: false,
    publicHost: null,
    leaseSeconds: null,
    message:
      failures.length > 0
        ? `Automatic port opening did not succeed (${failures.join('; ')}). ` +
          `Forward ${mapping.externalPort}/${mapping.protocol} to ${environment.localAddress ?? 'this machine'} on your router, or enable relay mode.`
        : `Forward ${mapping.externalPort}/${mapping.protocol} to ${environment.localAddress ?? 'this machine'} on your router, or enable relay mode.`,
    exposesHostIp: true,
  };
}

/** Removes every mapping for a server. Called on delete and on stop. */
export async function releaseServerPortMappings(serverId: string): Promise<void> {
  const allocations = await prisma.portAllocation.findMany({
    where: { serverId, active: true },
  });
  if (allocations.length === 0) return;

  const environment = await getNatEnvironment();

  for (const allocation of allocations) {
    const mapping: MappingRequest = {
      internalPort: allocation.internalPort,
      externalPort: allocation.externalPort,
      protocol: allocation.protocol as 'udp' | 'tcp',
      leaseSeconds: 0,
      description: '',
    };

    try {
      switch (allocation.method) {
        case PortMethod.NATPMP:
        case PortMethod.PCP:
          if (environment.gateway) await natpmpUnmap(environment.gateway, mapping);
          break;
        case PortMethod.UPNP:
          if (environment.upnpDevice) await upnpUnmap(environment.upnpDevice, mapping);
          break;
        case PortMethod.RELAY:
          await closeRelayTunnel(serverId, allocation.portKey);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.warn({ err: error, allocationId: allocation.id }, 'Failed to remove port mapping');
    }

    await prisma.portAllocation.update({
      where: { id: allocation.id },
      data: { active: false, leaseExpiresAt: null, message: 'Mapping removed' },
    });
  }
}

/**
 * Renews leases that are close to expiry.
 *
 * UPnP and NAT-PMP leases are typically an hour; without renewal a server
 * silently becomes unreachable mid-session.
 */
export async function renewExpiringMappings(): Promise<number> {
  const soon = new Date(Date.now() + 10 * 60 * 1000);
  const due = await prisma.portAllocation.findMany({
    where: { active: true, leaseExpiresAt: { not: null, lt: soon } },
    include: { server: true },
  });

  const environment = await getNatEnvironment();
  let renewed = 0;

  for (const allocation of due) {
    if (!allocation.server || allocation.server.deletedAt) continue;

    const mapping: MappingRequest = {
      internalPort: allocation.internalPort,
      externalPort: allocation.externalPort,
      protocol: allocation.protocol as 'udp' | 'tcp',
      leaseSeconds: 3600,
      description: `ArmaServerPanel ${allocation.portKey}`,
    };

    let ok = false;
    try {
      if (allocation.method === PortMethod.NATPMP && environment.gateway) {
        ok = (await natpmpMap(environment.gateway, mapping))?.success ?? false;
      } else if (allocation.method === PortMethod.PCP && environment.gateway && environment.localAddress) {
        ok = (await pcpMap(environment.gateway, mapping, environment.localAddress))?.success ?? false;
      } else if (allocation.method === PortMethod.UPNP && environment.upnpDevice && environment.localAddress) {
        ok = (await upnpMap(environment.upnpDevice, mapping, environment.localAddress)).success;
      }
    } catch (error) {
      logger.warn({ err: error, allocationId: allocation.id }, 'Lease renewal failed');
    }

    await prisma.portAllocation.update({
      where: { id: allocation.id },
      data: {
        active: ok,
        leaseExpiresAt: ok ? new Date(Date.now() + 3600 * 1000) : null,
        lastVerifiedAt: new Date(),
        message: ok ? 'Lease renewed' : 'Lease renewal failed - the server may be unreachable',
      },
    });

    if (ok) renewed += 1;
  }

  return renewed;
}

/**
 * Only ports the game definition marks `public: true` are ever opened to the
 * internet. RCON and BattlEye stay LAN-only no matter what a caller requests.
 */
function isPublicPortKey(portKey: string, gameTitle: string): boolean {
  const gameId: GameId =
    gameTitle === 'ARMA3' ? 'arma3' : gameTitle === 'REFORGER' ? 'reforger' : 'arma4';
  return GAMES[gameId].ports.find((p) => p.key === portKey)?.public ?? false;
}

export { loadConfig };
