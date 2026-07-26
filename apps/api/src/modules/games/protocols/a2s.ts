/**
 * Source engine A2S query protocol (UDP).
 *
 * Implemented directly: it is a small binary protocol and pulling in a
 * dependency for it would mean trusting third-party code with unvalidated
 * network input from arbitrary game servers.
 *
 * Every read is bounds-checked. A hostile or malfunctioning server sending a
 * truncated or oversized packet gets a parse failure, not a crash.
 */

import { createSocket } from 'node:dgram';

const A2S_INFO = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from('Source Engine Query\0', 'ascii'),
]);

const HEADER_SIMPLE = 0xffffffff;
const RESPONSE_INFO = 0x49;
const RESPONSE_CHALLENGE = 0x41;

const MAX_PACKET = 4096;

export interface A2SInfo {
  protocol: number;
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number;
  players: number;
  maxPlayers: number;
  bots: number;
  serverType: string;
  environment: string;
  visibility: number;
  vac: number;
  version: string;
  ping: number;
}

/** Bounds-checked sequential reader. */
class Reader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  u8(): number {
    if (this.remaining < 1) throw new RangeError('A2S: truncated u8');
    return this.buffer.readUInt8(this.offset++);
  }

  u16(): number {
    if (this.remaining < 2) throw new RangeError('A2S: truncated u16');
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  i32(): number {
    if (this.remaining < 4) throw new RangeError('A2S: truncated i32');
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  /** NUL-terminated string, capped so a missing terminator cannot run away. */
  string(maxLength = 512): string {
    const end = this.buffer.indexOf(0, this.offset);
    if (end === -1 || end - this.offset > maxLength) {
      throw new RangeError('A2S: unterminated or oversized string');
    }
    const value = this.buffer.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return value;
  }
}

async function sendQuery(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<{ data: Buffer; ping: number }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const startedAt = performance.now();
    let settled = false;

    const finish = (error: Error | null, data?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close(() => undefined);
      if (error) reject(error);
      else resolve({ data: data!, ping: Math.round(performance.now() - startedAt) });
    };

    const timer = setTimeout(() => finish(new Error('A2S query timed out')), timeoutMs);

    socket.on('error', (error) => finish(error));
    socket.on('message', (message) => {
      if (message.length > MAX_PACKET) {
        return finish(new Error('A2S response too large'));
      }
      finish(null, message);
    });

    socket.send(payload, port, host, (error) => {
      if (error) finish(error);
    });
  });
}

export async function queryA2SInfo(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<A2SInfo | null> {
  try {
    let response = await sendQuery(host, port, A2S_INFO, timeoutMs);
    let reader = new Reader(response.data);

    if (reader.i32() !== HEADER_SIMPLE) return null;
    let type = reader.u8();

    // Modern servers reply with a challenge that must be echoed back.
    if (type === RESPONSE_CHALLENGE) {
      if (reader.remaining < 4) return null;
      const challenge = response.data.subarray(response.data.length - 4);
      response = await sendQuery(host, port, Buffer.concat([A2S_INFO, challenge]), timeoutMs);
      reader = new Reader(response.data);
      if (reader.i32() !== HEADER_SIMPLE) return null;
      type = reader.u8();
    }

    if (type !== RESPONSE_INFO) return null;

    const protocol = reader.u8();
    const name = reader.string(256);
    const map = reader.string(128);
    const folder = reader.string(128);
    const game = reader.string(128);
    const appId = reader.u16();
    const players = reader.u8();
    const maxPlayers = reader.u8();
    const bots = reader.u8();
    const serverType = String.fromCharCode(reader.u8());
    const environment = String.fromCharCode(reader.u8());
    const visibility = reader.u8();
    const vac = reader.u8();
    const version = reader.string(64);

    return {
      protocol,
      name,
      map,
      folder,
      game,
      appId,
      players,
      maxPlayers,
      bots,
      serverType,
      environment,
      visibility,
      vac,
      version,
      ping: response.ping,
    };
  } catch {
    // A failed query means "offline or not answering", never an exception that
    // takes down the polling loop.
    return null;
  }
}
