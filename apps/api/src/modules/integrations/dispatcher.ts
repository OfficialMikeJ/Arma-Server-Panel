/**
 * Outbound notifications: Discord webhooks and Pushover.
 *
 * Every destination is user-supplied, so every send goes through `safeFetch`
 * with a host allowlist. Payloads carry player names and server names, which
 * are attacker-controlled strings, so they are escaped for the destination's
 * markup before being embedded.
 */

import type { IntegrationKind } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { decryptSecretToString } from '../../security/crypto.js';
import { safeFetch, DISCORD_WEBHOOK_HOSTS, PUSHOVER_HOSTS } from '../../security/ssrf.js';

export type IntegrationEvent =
  | 'start'
  | 'stop'
  | 'crash'
  | 'reinstall'
  | 'update'
  | 'player_join'
  | 'player_leave'
  | 'alert';

export interface EventContext {
  serverName: string;
  playerName?: string;
  message?: string;
  exitCode?: number;
  oomKilled?: boolean;
  crashCount?: number;
}

/** Discord renders markdown; neutralise it so a player name cannot inject formatting or a mention. */
function escapeDiscord(text: string): string {
  return text
    .replace(/[\\*_~`|>]/g, (match) => `\\${match}`)
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?\d+>/g, '[mention removed]')
    .slice(0, 256);
}

function escapePlain(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
}

const EVENT_PRESENTATION: Record<
  IntegrationEvent,
  { title: string; color: number; priority: number }
> = {
  start: { title: 'Server started', color: 0x22c55e, priority: 0 },
  stop: { title: 'Server stopped', color: 0x94a3b8, priority: 0 },
  crash: { title: 'Server crashed', color: 0xef4444, priority: 1 },
  reinstall: { title: 'Server reinstalled', color: 0x3b82f6, priority: 0 },
  update: { title: 'Server updated', color: 0x3b82f6, priority: 0 },
  player_join: { title: 'Player joined', color: 0x22c55e, priority: -1 },
  player_leave: { title: 'Player left', color: 0x94a3b8, priority: -1 },
  alert: { title: 'Alert', color: 0xff6a00, priority: 1 },
};

export async function dispatchEvent(
  serverId: string,
  event: IntegrationEvent,
  context: EventContext,
): Promise<void> {
  const integrations = await prisma.integration
    .findMany({ where: { serverId, enabled: true } })
    .catch(() => []);

  for (const integration of integrations) {
    if (!integration.events.includes(event)) continue;

    try {
      await send(integration.kind, integration.secretsEnc, event, context);
      await prisma.integration.update({
        where: { id: integration.id },
        data: { lastSentAt: new Date(), failureCount: 0 },
      });
    } catch (error) {
      logger.warn(
        { err: error, integrationId: integration.id, kind: integration.kind },
        'Integration delivery failed',
      );

      const updated = await prisma.integration.update({
        where: { id: integration.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });

      // A destination that keeps failing is disabled rather than retried
      // forever - a dead webhook should not slow every event dispatch.
      if (updated.failureCount >= 10) {
        await prisma.integration.update({
          where: { id: integration.id },
          data: { enabled: false },
        });
        logger.warn({ integrationId: integration.id }, 'Integration disabled after repeated failures');
      }
    }
  }
}

async function send(
  kind: IntegrationKind,
  secretsEnc: Uint8Array,
  event: IntegrationEvent,
  context: EventContext,
): Promise<void> {
  const secrets = JSON.parse(decryptSecretToString(secretsEnc, 'integration')) as Record<string, string>;
  const presentation = EVENT_PRESENTATION[event];

  if (kind === 'DISCORD_WEBHOOK') {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: 'Server', value: escapeDiscord(context.serverName), inline: true },
    ];
    if (context.playerName) {
      fields.push({ name: 'Player', value: escapeDiscord(context.playerName), inline: true });
    }
    if (context.exitCode !== undefined) {
      fields.push({ name: 'Exit code', value: String(context.exitCode), inline: true });
    }
    if (context.message) {
      fields.push({ name: 'Details', value: escapeDiscord(context.message), inline: false });
    }

    const response = await safeFetch(secrets.webhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      allowedHosts: DISCORD_WEBHOOK_HOSTS,
      body: JSON.stringify({
        username: 'Arma Server Panel',
        // Suppress every mention type regardless of message content.
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: presentation.title,
            color: presentation.color,
            fields,
            timestamp: new Date().toISOString(),
            footer: { text: 'Arma Server Panel' },
          },
        ],
      }),
      timeoutMs: 8000,
    });

    if (response.status >= 400) {
      throw new Error(`Discord webhook returned ${response.status}`);
    }
    return;
  }

  if (kind === 'PUSHOVER') {
    const body = new URLSearchParams({
      token: secrets.apiToken!,
      user: secrets.userKey!,
      title: `${presentation.title}: ${escapePlain(context.serverName)}`,
      message: escapePlain(
        context.message ??
          (context.playerName ? `${context.playerName}` : presentation.title),
      ),
      priority: String(presentation.priority),
    });

    const response = await safeFetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      allowedHosts: PUSHOVER_HOSTS,
      body: body.toString(),
      timeoutMs: 8000,
    });

    if (response.status >= 400) {
      throw new Error(`Pushover returned ${response.status}`);
    }
    return;
  }

  if (kind === 'GENERIC_WEBHOOK') {
    const response = await safeFetch(secrets.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event,
        server: escapePlain(context.serverName),
        player: context.playerName ? escapePlain(context.playerName) : undefined,
        message: context.message ? escapePlain(context.message) : undefined,
        at: new Date().toISOString(),
      }),
      timeoutMs: 8000,
    });
    if (response.status >= 400) throw new Error(`Webhook returned ${response.status}`);
  }
}

/** Sends a test payload so an operator can confirm a destination works. */
export async function sendTestEvent(integrationId: string): Promise<void> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) throw new Error('Integration not found');

  await send(integration.kind, integration.secretsEnc, 'alert', {
    serverName: 'Test',
    message: 'This is a test notification from Arma Server Panel.',
  });
}
