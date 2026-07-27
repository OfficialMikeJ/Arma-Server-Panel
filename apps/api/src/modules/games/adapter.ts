/**
 * Game adapter contract.
 *
 * Everything title-specific lives behind this interface: config file format,
 * startup flags, mod handling, query protocol, log parsing. Adding Arma 4 when
 * it ships means writing one adapter, not touching the orchestration layer.
 */

import type { Server } from '@prisma/client';
import type { GameId, ModEntry } from '@asp/shared';

export interface DefaultConfigInput {
  name: string;
  slots: number;
}

export interface ParsedLogEvent {
  kind: 'player_join' | 'player_leave' | 'error' | 'ready' | 'shutdown' | 'fps' | 'other';
  message: string;
  playerName?: string;
  fps?: number;
}

export interface QueryResult {
  online: boolean;
  playersOnline: number;
  maxPlayers: number;
  serverName: string | null;
  map: string | null;
  version: string | null;
  ping: number | null;
}

export interface GameAdapter {
  readonly id: GameId;

  /** Config object stored in `servers.config`, validated on every write. */
  defaultConfig(input: DefaultConfigInput): Record<string, unknown>;

  /** Validates and normalises an operator-supplied config patch. */
  validateConfig(patch: unknown, current: Record<string, unknown>): Record<string, unknown>;

  /** Non-secret environment passed to the container. */
  /**
   * Environment for the game container.
   *
   * Async because Steam credentials are read from the panel's own store, which
   * is where an operator sets them - the environment is only a fallback.
   */
  buildEnv(server: Server): Promise<Record<string, string>>;

  /** Renders and writes the game's native config file into the volume. */
  writeConfig(server: Server): Promise<void>;

  /** Renders the mod list into the game's native format. */
  writeMods(server: Server, mods: ModEntry[]): Promise<void>;

  /** Queries the running server for player counts. */
  query(server: Server): Promise<QueryResult>;

  /** Classifies a console line so the panel can raise events from it. */
  parseLogLine(line: string): ParsedLogEvent;

  /** Sends an RCON command. Returns the server's reply. */
  sendRconCommand(server: Server, command: string): Promise<string>;
}

/** Secrets stored encrypted on the server row. */
export interface ServerSecrets {
  rconPassword: string;
  adminPassword: string;
  battleyeRconPassword: string;
}
