/**
 * Server supervisor.
 *
 * Owns the live view of every running container: attaches to its log stream,
 * samples stats, tracks player counts, and decides what to do when a server
 * exits. Docker's own restart policy is deliberately off (see container-spec)
 * so that crash handling goes through here, where the crash-loop limit and
 * owner notifications live.
 */

import type { Readable } from 'node:stream';
import { CONSOLE_LIMITS, METRICS } from '@asp/shared';
import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import {
  demuxDockerStream,
  getLogStream,
  inspectContainer,
  sampleStats,
  startContainer,
} from '../docker/container-manager.js';
import { appendConsoleLine, emitPanelNotice } from './console-buffer.js';
import { explainSteamFailure } from '../platform/steam-credentials.js';
import { getAdapter } from '../games/registry.js';
import { toGameId, setState } from './server-service.js';
import { dispatchEvent } from '../integrations/dispatcher.js';

interface Attachment {
  serverId: string;
  containerName: string;
  stream: Readable | null;
  carry: { buffer: Buffer };
  /** Console lines buffered for the next batched database write. */
  pending: Array<{ seq: bigint; at: Date; stream: string; text: string }>;
  seq: bigint;
  restarting: boolean;
}

class ServerSupervisor {
  private readonly attachments = new Map<string, Attachment>();
  private statsTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;

  // Re-entrancy guards: a tick is skipped rather than queued, because the next
  // one will pick up the same work anyway.
  private samplingBusy = false;
  private flushBusy = false;
  private reconcileBusy = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.reconcile().catch((error) => {
      logger.error({ err: error }, 'Initial supervisor reconcile failed');
    });

    // Each loop talks to Docker once per server, so a busy node or a slow
    // daemon can easily take longer than the interval. Without these guards the
    // runs overlap, duplicating metric samples and racing the log attachment.
    this.statsTimer = setInterval(() => {
      if (this.samplingBusy) return;
      this.samplingBusy = true;
      void this.sampleAll()
        .catch((error) => logger.error({ err: error }, 'Stats sampling failed'))
        .finally(() => {
          this.samplingBusy = false;
        });
    }, METRICS.sampleIntervalMs);

    this.persistTimer = setInterval(() => {
      if (this.flushBusy) return;
      this.flushBusy = true;
      void this.flushConsole()
        .catch((error) => logger.error({ err: error }, 'Console persistence failed'))
        .finally(() => {
          this.flushBusy = false;
        });
    }, 5_000);

    this.reconcileTimer = setInterval(() => {
      if (this.reconcileBusy) return;
      this.reconcileBusy = true;
      void this.reconcile()
        .catch((error) => logger.error({ err: error }, 'Supervisor reconcile failed'))
        .finally(() => {
          this.reconcileBusy = false;
        });
    }, 30_000);

    this.statsTimer.unref();
    this.persistTimer.unref();
    this.reconcileTimer.unref();

    logger.info('Server supervisor started');
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of [this.statsTimer, this.persistTimer, this.reconcileTimer]) {
      if (timer) clearInterval(timer);
    }
    this.statsTimer = this.persistTimer = this.reconcileTimer = null;

    for (const attachment of this.attachments.values()) {
      attachment.stream?.destroy();
    }
    await this.flushConsole().catch(() => undefined);
    this.attachments.clear();

    logger.info('Server supervisor stopped');
  }

  /**
   * Brings the in-memory view in line with reality: attaches to containers we
   * are not watching, detaches from ones that are gone, and reacts to exits.
   */
  private async reconcile(): Promise<void> {
    const servers = await prisma.server.findMany({
      where: { deletedAt: null, state: { notIn: ['DELETING', 'CREATING'] } },
      select: {
        id: true,
        containerName: true,
        state: true,
        autoRestart: true,
        crashRestartLimit: true,
        crashCount: true,
        suspended: true,
        ownerId: true,
        name: true,
      },
    });

    const live = new Set<string>();

    for (const server of servers) {
      const status = await inspectContainer(server.containerName).catch(() => null);
      if (!status) continue;

      if (status.running) {
        live.add(server.id);
        if (!this.attachments.has(server.id)) {
          await this.attach(server.id, server.containerName);
        }
        if (server.state !== 'RUNNING') {
          await setState(server.id, 'RUNNING');
        }
        continue;
      }

      // Not running. Detach if we still hold a stream.
      const attachment = this.attachments.get(server.id);
      if (attachment) {
        attachment.stream?.destroy();
        this.attachments.delete(server.id);
      }

      const wasExpectedUp = server.state === 'RUNNING' || server.state === 'STARTING';
      if (!wasExpectedUp) continue;

      const crashed = status.exitCode !== null && status.exitCode !== 0;
      const oom = status.oomKilled;

      if (oom) {
        emitPanelNotice(
          server.id,
          'The server was killed for exceeding its memory limit. Increase the RAM allocation or reduce mods and AI count.',
        );
      }

      if (crashed || oom) {
        // A container that dies within a second of starting is gone before the
        // log stream attaches, so "exit code 1" arrives with no explanation.
        // Pull whatever it did print and put it on the console.
        await this.emitCrashOutput(server.id, server.containerName);
        await this.handleCrash(server, status.exitCode ?? -1, oom);
      } else {
        await setState(server.id, 'OFFLINE');
        emitPanelNotice(server.id, 'Server stopped.');
        await dispatchEvent(server.id, 'stop', { serverName: server.name });
      }
    }

    // Drop attachments for servers that no longer exist.
    for (const serverId of [...this.attachments.keys()]) {
      if (!live.has(serverId)) {
        this.attachments.get(serverId)?.stream?.destroy();
        this.attachments.delete(serverId);
      }
    }
  }

  /**
   * Reads the final output of an exited container onto the server console.
   *
   * Without this a fast failure - a missing credential, a bad config line -
   * surfaces only as an exit code, which tells an operator nothing about what
   * to fix.
   */
  private async emitCrashOutput(serverId: string, containerName: string): Promise<void> {
    try {
      const stream = await getLogStream(containerName, { follow: false, tail: 40 });
      const carry = { buffer: Buffer.alloc(0) };
      const lines: string[] = [];

      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        stream.on('data', (chunk: Buffer) => {
          demuxDockerStream(
            chunk,
            (_kind, rawLine) => {
              const text = rawLine.replace(/^\S+Z\s?/, '').trim();
              if (text) lines.push(text);
            },
            carry,
          );
        });
        stream.on('end', done);
        stream.on('error', done);
        setTimeout(done, 5000).unref();
      });

      if (lines.length === 0) return;

      emitPanelNotice(serverId, '--- last output before it exited ---');
      for (const line of lines.slice(-40)) {
        appendConsoleLine(serverId, 'stderr', line);
      }
      emitPanelNotice(serverId, '--- end of output ---');
    } catch {
      // Diagnostics are best-effort; never let them mask the crash itself.
    }
  }

  private async handleCrash(
    server: {
      id: string;
      name: string;
      autoRestart: boolean;
      crashRestartLimit: number;
      crashCount: number;
      suspended: boolean;
      containerName: string;
      ownerId: string;
    },
    exitCode: number,
    oomKilled: boolean,
  ): Promise<void> {
    const crashCount = server.crashCount + 1;

    await prisma.server.update({
      where: { id: server.id },
      data: { state: 'CRASHED', crashCount, playersOnline: 0 },
    });

    await prisma.serverEvent.create({
      data: {
        serverId: server.id,
        kind: 'crash',
        message: oomKilled
          ? 'Server killed: out of memory'
          : `Server exited unexpectedly with code ${exitCode}`,
        data: { exitCode, oomKilled, crashCount },
      },
    });

    emitPanelNotice(
      server.id,
      oomKilled
        ? 'Server crashed: out of memory.'
        : `Server crashed (exit code ${exitCode}).`,
    );

    await dispatchEvent(server.id, 'crash', {
      serverName: server.name,
      exitCode,
      oomKilled,
      crashCount,
    });

    const canRestart =
      server.autoRestart &&
      !server.suspended &&
      (server.crashRestartLimit === 0 || crashCount <= server.crashRestartLimit);

    if (!canRestart) {
      emitPanelNotice(
        server.id,
        server.autoRestart
          ? `Crash restart limit (${server.crashRestartLimit}) reached. The server will stay offline until you start it manually.`
          : 'Automatic restart is disabled for this server.',
      );
      return;
    }

    // Back off so a server that crashes on startup does not spin.
    const backoffMs = Math.min(60_000, 2 ** Math.min(crashCount, 5) * 1000);
    emitPanelNotice(
      server.id,
      `Restarting automatically in ${Math.round(backoffMs / 1000)}s (attempt ${crashCount}).`,
    );

    setTimeout(() => {
      void (async () => {
        try {
          const current = await prisma.server.findUnique({
            where: { id: server.id },
            select: { state: true, deletedAt: true, suspended: true },
          });
          // The owner may have intervened while we were waiting.
          if (!current || current.deletedAt || current.suspended || current.state !== 'CRASHED') {
            return;
          }
          await setState(server.id, 'STARTING');
          await startContainer(server.containerName);
          emitPanelNotice(server.id, 'Automatic restart issued.');
        } catch (error) {
          logger.error({ err: error, serverId: server.id }, 'Automatic restart failed');
          emitPanelNotice(server.id, 'Automatic restart failed.');
          await setState(server.id, 'CRASHED').catch(() => undefined);
        }
      })();
    }, backoffMs).unref();
  }

  /* ---------------------------------------------------------------- */
  /* Log attachment                                                    */
  /* ---------------------------------------------------------------- */

  private async attach(serverId: string, containerName: string): Promise<void> {
    if (this.attachments.has(serverId)) return;

    const attachment: Attachment = {
      serverId,
      containerName,
      stream: null,
      carry: { buffer: Buffer.alloc(0) },
      pending: [],
      seq: 0n,
      restarting: false,
    };
    this.attachments.set(serverId, attachment);

    try {
      const last = await prisma.consoleLine.findFirst({
        where: { serverId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      attachment.seq = last?.seq ?? 0n;

      const stream = await getLogStream(containerName, { follow: true, tail: 200 });
      attachment.stream = stream;

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { game: true, name: true },
      });
      const adapter = server ? getAdapter(toGameId(server.game)) : null;
    // A new attachment means a new run, so a repeat failure is worth repeating.
    this.steamFailureReported.delete(serverId);

      stream.on('data', (chunk: Buffer) => {
        demuxDockerStream(
          chunk,
          (kind, rawLine) => {
            // Docker prefixes each line with an RFC3339 timestamp.
            const text = rawLine.replace(/^\S+Z\s?/, '');
            const line = appendConsoleLine(serverId, kind, text);

            attachment.seq += 1n;
            attachment.pending.push({
              seq: attachment.seq,
              at: new Date(line.at),
              stream: kind,
              text: line.text,
            });
            if (attachment.pending.length > 5000) {
              attachment.pending.splice(0, attachment.pending.length - 5000);
            }

            // SteamCMD's own wording for a rejected login is easy to miss in a
            // wall of download output, and the panel would otherwise just say
            // "crashed". Said plainly, once, in the operator's own console.
            this.explainSteamFailureOnce(serverId, line.text);

            if (adapter) this.handleLogEvent(serverId, adapter.parseLogLine(line.text), server!.name);
          },
          attachment.carry,
        );
      });

      stream.on('error', (error) => {
        logger.warn({ err: error, serverId }, 'Log stream error');
        this.attachments.delete(serverId);
      });

      stream.on('end', () => {
        this.attachments.delete(serverId);
      });

      logger.debug({ serverId, containerName }, 'Attached to container logs');
    } catch (error) {
      logger.warn({ err: error, serverId }, 'Could not attach to container logs');
      this.attachments.delete(serverId);
    }
  }

  private handleLogEvent(
    serverId: string,
    event: ReturnType<ReturnType<typeof getAdapter>['parseLogLine']>,
    serverName: string,
  ): void {
    switch (event.kind) {
      case 'player_join':
        void dispatchEvent(serverId, 'player_join', {
          serverName,
          playerName: event.playerName ?? 'unknown',
        });
        break;
      case 'player_leave':
        void dispatchEvent(serverId, 'player_leave', {
          serverName,
          playerName: event.playerName ?? 'unknown',
        });
        break;
      case 'ready':
        void prisma.serverEvent
          .create({ data: { serverId, kind: 'ready', message: 'Server reported ready' } })
          .catch(() => undefined);
        void dispatchEvent(serverId, 'start', { serverName });
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Persistence + sampling                                            */
  /* ---------------------------------------------------------------- */

  /** Batches console lines to the database. "For days, not minutes." */
  /**
   * Surfaces a Steam login failure in words an operator can act on.
   *
   * Once per attachment: SteamCMD repeats itself, and the same paragraph three
   * times is noise rather than emphasis. Reset when the container is reattached,
   * so a later attempt is explained again.
   */
  private steamFailureReported = new Set<string>();

  private explainSteamFailureOnce(serverId: string, text: string): void {
    if (this.steamFailureReported.has(serverId)) return;

    const explanation = explainSteamFailure(text);
    if (!explanation) return;

    this.steamFailureReported.add(serverId);
    emitPanelNotice(serverId, explanation);
    logger.warn({ serverId }, 'Steam login was rejected during install');
  }

  private async flushConsole(): Promise<void> {
    for (const attachment of this.attachments.values()) {
      if (attachment.pending.length === 0) continue;
      const batch = attachment.pending.splice(0, attachment.pending.length);

      await prisma.consoleLine
        .createMany({
          data: batch.map((line) => ({
            serverId: attachment.serverId,
            seq: line.seq,
            at: line.at,
            stream: line.stream,
            text: line.text.slice(0, CONSOLE_LIMITS.maxLineBytes),
          })),
          skipDuplicates: true,
        })
        .catch((error) => {
          logger.warn({ err: error, serverId: attachment.serverId }, 'Console batch write failed');
        });
    }
  }

  private async sampleAll(): Promise<void> {
    const servers = await prisma.server.findMany({
      where: { deletedAt: null, state: 'RUNNING' },
      select: {
        id: true,
        containerName: true,
        game: true,
        basePort: true,
        slots: true,
        publicHost: true,
        publicBasePort: true,
        transferQuotaGib: true,
        name: true,
        suspended: true,
      },
    });

    for (const server of servers) {
      const stats = await sampleStats(server.containerName).catch(() => null);
      if (!stats) continue;

      let playersOnline = 0;
      try {
        const adapter = getAdapter(toGameId(server.game));
        const query = await adapter.query(server as never);
        playersOnline = query.playersOnline;
      } catch {
        // A failed query is not fatal - the container may still be booting.
      }

      const diskBytes = BigInt(stats.blockReadBytes + stats.blockWriteBytes);

      await prisma.metricSample.create({
        data: {
          serverId: server.id,
          cpuPercent: stats.cpuPercent,
          memoryBytes: BigInt(Math.round(stats.memoryBytes)),
          memoryLimitBytes: BigInt(Math.round(stats.memoryLimitBytes)),
          diskBytes,
          netRxBytes: BigInt(stats.netRxBytes),
          netTxBytes: BigInt(stats.netTxBytes),
          playersOnline,
        },
      }).catch(() => undefined);

      await prisma.server
        .update({
          where: { id: server.id },
          data: { playersOnline, lastQueryAt: new Date() },
        })
        .catch(() => undefined);

      await this.accountBandwidth(server, stats.netRxBytes, stats.netTxBytes);
    }
  }

  /**
   * Rolls network counters into the monthly usage table and suspends a server
   * that blows through its transfer quota.
   */
  private async accountBandwidth(
    server: { id: string; transferQuotaGib: number; name: string; suspended: boolean },
    rxBytes: number,
    txBytes: number,
  ): Promise<void> {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Docker's counters are cumulative for the container's lifetime, so store
    // the absolute value and let the report compute deltas across restarts.
    await prisma.bandwidthUsage
      .upsert({
        where: { serverId_periodStart: { serverId: server.id, periodStart } },
        create: {
          serverId: server.id,
          periodStart,
          rxBytes: BigInt(rxBytes),
          txBytes: BigInt(txBytes),
        },
        update: { rxBytes: BigInt(rxBytes), txBytes: BigInt(txBytes) },
      })
      .catch(() => undefined);

    if (server.transferQuotaGib <= 0 || server.suspended) return;

    const totalGib = (rxBytes + txBytes) / 1024 ** 3;
    if (totalGib < server.transferQuotaGib) return;

    logger.warn(
      { serverId: server.id, totalGib, quota: server.transferQuotaGib },
      'Server exceeded its transfer quota',
    );

    await prisma.server.update({
      where: { id: server.id },
      data: {
        suspended: true,
        suspendReason: `Monthly transfer quota of ${server.transferQuotaGib} GB exceeded`,
      },
    });

    emitPanelNotice(
      server.id,
      `This server has used its ${server.transferQuotaGib} GB monthly transfer allowance and has been suspended.`,
    );
    await dispatchEvent(server.id, 'alert', {
      serverName: server.name,
      message: 'Transfer quota exceeded - server suspended',
    });
  }

  isAttached(serverId: string): boolean {
    return this.attachments.has(serverId);
  }
}

export const serverSupervisor = new ServerSupervisor();
