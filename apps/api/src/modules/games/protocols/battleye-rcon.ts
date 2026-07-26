/**
 * BattlEye RCON (UDP).
 *
 * Packet layout:
 *   'B' 'E' | CRC32-LE of everything from the 0xFF onwards | 0xFF | type | payload
 *
 * Types: 0x00 login, 0x01 command, 0x02 server message.
 *
 * Security notes:
 *   * The protocol has no transport security at all - the password crosses the
 *     wire in the login packet. The panel therefore never publishes the RCON
 *     port to the internet (see games.ts: `public: false`) and only ever talks
 *     to it across the loopback/bridge interface.
 *   * Multipart responses are reassembled with a hard cap so a hostile server
 *     cannot drive unbounded memory growth.
 *   * The connection is torn down on any protocol violation rather than
 *     attempting to resynchronise.
 */

import { createSocket, type Socket } from 'node:dgram';
import { logger } from '../../../lib/logger.js';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

function buildPacket(type: number, payload: Buffer): Buffer {
  const inner = Buffer.concat([Buffer.from([0xff, type]), payload]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32LE(crc32(inner), 0);
  return Buffer.concat([Buffer.from('BE', 'ascii'), checksum, inner]);
}

const MAX_RESPONSE_BYTES = 512 * 1024;
const KEEPALIVE_MS = 25_000;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export class BattlEyeRconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BattlEyeRconError';
  }
}

interface PendingCommand {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  parts: Map<number, string>;
  totalParts: number | null;
  received: number;
}

/**
 * A short-lived connection used for a single command exchange.
 *
 * Keeping connections open would mean holding a decrypted password in memory
 * indefinitely; opening one per command costs a round trip and is the safer
 * trade for an admin panel.
 */
export class BattlEyeRconClient {
  private socket: Socket | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private keepalive: NodeJS.Timeout | null = null;
  private loggedIn = false;
  private readonly timeoutMs: number;
  /** Unsolicited server messages, delivered to whoever is listening. */
  private messageHandler: ((text: string) => void) | null = null;

  constructor(private readonly options: RconOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  onServerMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.loggedIn) return;

    this.socket = createSocket('udp4');

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const timer = setTimeout(() => {
        cleanup();
        reject(new BattlEyeRconError('RCON login timed out'));
      }, this.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('message', onLogin);
        socket.off('error', onError);
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(new BattlEyeRconError(`RCON socket error: ${error.message}`));
      };

      const onLogin = (message: Buffer): void => {
        const parsed = this.parseHeader(message);
        if (!parsed || parsed.type !== 0x00) {
          cleanup();
          reject(new BattlEyeRconError('Unexpected response to RCON login'));
          return;
        }
        if (parsed.payload[0] !== 0x01) {
          cleanup();
          reject(new BattlEyeRconError('RCON login rejected'));
          return;
        }
        cleanup();
        this.loggedIn = true;
        socket.on('message', (msg) => this.handleMessage(msg));
        socket.on('error', (error) => {
          logger.warn({ err: error }, 'RCON socket error after login');
          this.close();
        });
        this.startKeepalive();
        resolve();
      };

      socket.on('message', onLogin);
      socket.on('error', onError);

      const packet = buildPacket(0x00, Buffer.from(this.options.password, 'ascii'));
      socket.send(packet, this.options.port, this.options.host, (error) => {
        if (error) onError(error);
      });
    });
  }

  private parseHeader(
    message: Buffer,
  ): { type: number; payload: Buffer } | null {
    if (message.length < 8) return null;
    if (message[0] !== 0x42 || message[1] !== 0x45) return null;
    if (message[6] !== 0xff) return null;

    const inner = message.subarray(6);
    const expected = message.readUInt32LE(2);
    if (crc32(inner) !== expected) {
      logger.debug('Discarded RCON packet with bad checksum');
      return null;
    }

    return { type: message[7]!, payload: message.subarray(8) };
  }

  private handleMessage(message: Buffer): void {
    const parsed = this.parseHeader(message);
    if (!parsed) return;

    // --- Server message: acknowledge, then surface it ---
    if (parsed.type === 0x02) {
      const seq = parsed.payload[0];
      if (seq === undefined) return;
      this.socket?.send(
        buildPacket(0x02, Buffer.from([seq])),
        this.options.port,
        this.options.host,
        () => undefined,
      );
      const text = parsed.payload.subarray(1).toString('utf8');
      if (text && this.messageHandler) this.messageHandler(text);
      return;
    }

    // --- Command response, possibly multipart ---
    if (parsed.type !== 0x01) return;

    const seq = parsed.payload[0];
    if (seq === undefined) return;
    const pending = this.pending.get(seq);
    if (!pending) return;

    let body = parsed.payload.subarray(1);
    let partIndex = 0;

    // Multipart marker: 0x00, total, index
    if (body.length >= 3 && body[0] === 0x00) {
      pending.totalParts = body[1] ?? 1;
      partIndex = body[2] ?? 0;
      body = body.subarray(3);
    } else {
      pending.totalParts = 1;
    }

    pending.received += body.length;
    if (pending.received > MAX_RESPONSE_BYTES) {
      clearTimeout(pending.timer);
      this.pending.delete(seq);
      pending.reject(new BattlEyeRconError('RCON response exceeded size limit'));
      return;
    }

    pending.parts.set(partIndex, body.toString('utf8'));

    if (pending.parts.size >= (pending.totalParts ?? 1)) {
      clearTimeout(pending.timer);
      this.pending.delete(seq);
      const ordered = [...pending.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join('');
      pending.resolve(ordered);
    }
  }

  async send(command: string): Promise<string> {
    if (!this.loggedIn || !this.socket) {
      throw new BattlEyeRconError('RCON is not connected');
    }
    // Control characters are rejected upstream by the console schema; this is
    // a second check because this method is also reachable from the AI module.
    if (/[\x00-\x1f\x7f]/.test(command)) {
      throw new BattlEyeRconError('Command contains control characters');
    }

    const seq = this.sequence;
    this.sequence = (this.sequence + 1) % 256;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new BattlEyeRconError('RCON command timed out'));
      }, this.timeoutMs);

      this.pending.set(seq, {
        resolve,
        reject,
        timer,
        parts: new Map(),
        totalParts: null,
        received: 0,
      });

      const payload = Buffer.concat([Buffer.from([seq]), Buffer.from(command, 'ascii')]);
      this.socket!.send(
        buildPacket(0x01, payload),
        this.options.port,
        this.options.host,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(seq);
            reject(new BattlEyeRconError(`Failed to send RCON command: ${error.message}`));
          }
        },
      );
    });
  }

  private startKeepalive(): void {
    this.keepalive = setInterval(() => {
      // An empty command packet is the documented keepalive.
      this.send('').catch(() => undefined);
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  close(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BattlEyeRconError('RCON connection closed'));
      this.pending.delete(seq);
    }
    this.loggedIn = false;
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }
}

/** Convenience: connect, run one command, disconnect. */
export async function runRconCommand(options: RconOptions, command: string): Promise<string> {
  const client = new BattlEyeRconClient(options);
  try {
    await client.connect();
    return await client.send(command);
  } finally {
    client.close();
  }
}
