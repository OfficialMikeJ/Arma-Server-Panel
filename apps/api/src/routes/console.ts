/**
 * Live console.
 *
 * "Live console access at all times. Through the Admin Panel and the HTTP API."
 *
 * WebSocket security notes:
 *   * Browsers do not enforce same-origin on WebSocket handshakes, so the
 *     Origin header is checked explicitly - otherwise any site could open an
 *     authenticated socket using the user's cookies.
 *   * Authorisation is resolved at upgrade time *and* re-checked before every
 *     command, so a permission revoked mid-session takes effect immediately.
 *   * Inbound frames are size-capped by the server config and rate-limited per
 *     socket.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { CONSOLE_LIMITS, RATE_LIMITS, consoleCommandSchema, cuidSchema, paginationSchema } from '@asp/shared';

import { prisma } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { buildKey, consumeRateLimit } from '../security/rate-limit.js';
import { forbidden, notFound, tooManyRequests } from '../lib/errors.js';
import {
  appendConsoleLine,
  getScrollback,
  subscribeConsole,
} from '../modules/servers/console-buffer.js';
import { getAdapter } from '../modules/games/registry.js';
import { loadServer, toGameId } from '../modules/servers/server-service.js';

export async function registerConsoleRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  /* -------------------------------------------------------------- */
  /* Scrollback over HTTP                                            */
  /* -------------------------------------------------------------- */

  app.get('/servers/:id/console', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:console.read');

    const query = z
      .object({
        afterSeq: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(CONSOLE_LIMITS.scrollbackLines).default(500),
        source: z.enum(['live', 'persisted']).default('live'),
      })
      .parse(request.query ?? {});

    if (query.source === 'live') {
      return reply.send({ lines: getScrollback(id, query.afterSeq, query.limit) });
    }

    // Persisted history - "graphs and logs with events history, for days".
    const rows = await prisma.consoleLine.findMany({
      where: { serverId: id, ...(query.afterSeq ? { seq: { gt: BigInt(query.afterSeq) } } : {}) },
      orderBy: { seq: 'desc' },
      take: query.limit,
    });

    return reply.send({
      lines: rows
        .reverse()
        .map((row) => ({
          seq: Number(row.seq),
          at: row.at.toISOString(),
          stream: row.stream,
          text: row.text,
        })),
    });
  });

  /* -------------------------------------------------------------- */
  /* Send a command (HTTP API)                                       */
  /* -------------------------------------------------------------- */

  app.post('/servers/:id/console', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:console.write');

    const body = consoleCommandSchema.parse(request.body);

    const limit = await consumeRateLimit(
      buildKey('console', id, request.auth.account!.id),
      RATE_LIMITS.console,
    );
    if (!limit.allowed) {
      throw tooManyRequests('Too many console commands.', limit.resetMs / 1000);
    }

    const response = await sendCommand(id, body.command, request.auth.account!.username);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.ConsoleCommand,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      // The command itself is recorded: this is an audited privileged action.
      metadata: { command: body.command.slice(0, 200) },
    });

    return reply.send({ ok: true, response });
  });

  /* -------------------------------------------------------------- */
  /* Live stream (WebSocket)                                         */
  /* -------------------------------------------------------------- */

  app.get(
    '/servers/:id/console/stream',
    { websocket: true, onRequest: [app.requireAuth, app.requireActiveAccount] },
    async (socket: WebSocket, request) => {
      const config = loadConfig();

      // Browsers do not apply same-origin to WebSockets. Check it ourselves.
      const origin = request.headers.origin;
      if (origin && origin !== config.appOrigin) {
        socket.close(1008, 'Origin not permitted');
        return;
      }

      let serverId: string;
      try {
        serverId = z.object({ id: cuidSchema }).parse(request.params).id;
      } catch {
        socket.close(1008, 'Invalid server id');
        return;
      }

      let access;
      try {
        access = await resolveServerAccess(request, serverId);
        assertPermission(access, 'server:console.read');
      } catch {
        socket.close(1008, 'Not permitted');
        return;
      }

      const account = request.auth.account!;
      const canWrite = access.permissions.has('server:console.write');

      const send = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      send({
        type: 'hello',
        serverId,
        canWrite,
        scrollback: getScrollback(serverId, 0, 500),
      });

      const unsubscribe = subscribeConsole(serverId, (line) => {
        send({ type: 'line', line });
      });

      // Keep the connection alive through proxies, and detect dead peers.
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }, 30_000);
      heartbeat.unref();

      socket.on('message', (raw) => {
        void (async () => {
          if (!canWrite) {
            send({ type: 'error', message: 'You do not have permission to send commands.' });
            return;
          }

          // Frames are capped by the websocket plugin's maxPayload; parse defensively.
          let parsed: { type?: string; command?: string };
          try {
            const text = raw.toString('utf8');
            if (text.length > CONSOLE_LIMITS.maxCommandLength + 64) {
              send({ type: 'error', message: 'Message too large.' });
              return;
            }
            parsed = JSON.parse(text);
          } catch {
            send({ type: 'error', message: 'Malformed message.' });
            return;
          }

          if (parsed.type !== 'command') return;

          const validation = consoleCommandSchema.safeParse({ command: parsed.command });
          if (!validation.success) {
            send({ type: 'error', message: validation.error.issues[0]?.message ?? 'Invalid command.' });
            return;
          }

          const limit = await consumeRateLimit(
            buildKey('console', serverId, account.id),
            RATE_LIMITS.console,
          );
          if (!limit.allowed) {
            send({ type: 'error', message: 'Slow down - too many commands.' });
            return;
          }

          // Re-check authorisation: a role may have been revoked since upgrade.
          try {
            const current = await resolveServerAccess(request, serverId);
            assertPermission(current, 'server:console.write');
          } catch {
            send({ type: 'error', message: 'Your access to this server has changed.' });
            socket.close(1008, 'Access revoked');
            return;
          }

          try {
            const response = await sendCommand(serverId, validation.data.command, account.username);
            send({ type: 'command_result', response });

            await audit({
              accountId: account.id,
              actorLabel: account.username,
              action: AuditAction.ConsoleCommand,
              targetType: 'server',
              targetId: serverId,
              ipHash: request.auth.client.ipHash,
              userAgentHash: request.auth.client.userAgentHash,
              metadata: { command: validation.data.command.slice(0, 200), transport: 'websocket' },
            });
          } catch (error) {
            send({
              type: 'error',
              message: error instanceof Error ? error.message : 'Command failed.',
            });
          }
        })();
      });

      socket.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      socket.on('error', (error) => {
        logger.debug({ err: error, serverId }, 'Console socket error');
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  /* -------------------------------------------------------------- */
  /* Events history                                                  */
  /* -------------------------------------------------------------- */

  app.get('/servers/:id/console/search', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:console.read');

    const query = z
      .object({
        // Treated as a literal substring, never as SQL or a regex.
        q: z.string().min(1).max(120),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query ?? {});

    const rows = await prisma.consoleLine.findMany({
      where: { serverId: id, text: { contains: query.q, mode: 'insensitive' } },
      orderBy: { seq: 'desc' },
      take: query.limit,
    });

    return reply.send({
      lines: rows.reverse().map((row) => ({
        seq: Number(row.seq),
        at: row.at.toISOString(),
        stream: row.stream,
        text: row.text,
      })),
    });
  });
}

/**
 * Routes a command to the game's RCON implementation and echoes it into the
 * shared console buffer so every watcher sees who ran what.
 */
async function sendCommand(serverId: string, command: string, actor: string): Promise<string> {
  const server = await loadServer(serverId);

  if (server.state !== 'RUNNING') {
    throw forbidden('The server is not running.');
  }

  appendConsoleLine(serverId, 'panel', `> [${actor}] ${command}`);

  const adapter = getAdapter(toGameId(server.game));
  const response = await adapter.sendRconCommand(server, command);

  if (response) appendConsoleLine(serverId, 'rcon', response);
  return response;
}
