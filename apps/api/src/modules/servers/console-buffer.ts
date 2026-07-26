/**
 * In-memory console scrollback with a fan-out to live subscribers.
 *
 * Every line is sanitised before it enters the buffer - ANSI escapes and
 * control characters are stripped, and each line is length-capped. Game server
 * logs echo player-controlled strings (names, chat), so treating them as
 * trusted output would let a player inject terminal escapes or oversized
 * payloads into an administrator's browser.
 */

import { CONSOLE_LIMITS, sanitizeConsoleText, type ConsoleLine, type ConsoleLineStream } from '@asp/shared';

type Subscriber = (line: ConsoleLine) => void;

interface ServerBuffer {
  lines: ConsoleLine[];
  nextSeq: number;
  subscribers: Set<Subscriber>;
}

const buffers = new Map<string, ServerBuffer>();

function getBuffer(serverId: string): ServerBuffer {
  let buffer = buffers.get(serverId);
  if (!buffer) {
    buffer = { lines: [], nextSeq: 1, subscribers: new Set() };
    buffers.set(serverId, buffer);
  }
  return buffer;
}

export function appendConsoleLine(
  serverId: string,
  stream: ConsoleLineStream,
  rawText: string,
): ConsoleLine {
  const buffer = getBuffer(serverId);

  const text = sanitizeConsoleText(rawText, CONSOLE_LIMITS.maxLineBytes);
  const line: ConsoleLine = {
    seq: buffer.nextSeq++,
    at: new Date().toISOString(),
    stream,
    text,
  };

  buffer.lines.push(line);
  if (buffer.lines.length > CONSOLE_LIMITS.scrollbackLines) {
    buffer.lines.splice(0, buffer.lines.length - CONSOLE_LIMITS.scrollbackLines);
  }

  for (const subscriber of buffer.subscribers) {
    try {
      subscriber(line);
    } catch {
      // A failing subscriber must not stop the others receiving output.
    }
  }

  return line;
}

/** Returns scrollback, optionally only lines newer than `afterSeq`. */
export function getScrollback(
  serverId: string,
  afterSeq = 0,
  limit: number = CONSOLE_LIMITS.scrollbackLines,
): ConsoleLine[] {
  const buffer = buffers.get(serverId);
  if (!buffer) return [];
  const filtered = afterSeq > 0 ? buffer.lines.filter((l) => l.seq > afterSeq) : buffer.lines;
  return filtered.slice(-limit);
}

export function subscribeConsole(serverId: string, subscriber: Subscriber): () => void {
  const buffer = getBuffer(serverId);
  buffer.subscribers.add(subscriber);
  return () => {
    buffer.subscribers.delete(subscriber);
    // Drop the buffer entirely once nobody is watching and it is empty.
    if (buffer.subscribers.size === 0 && buffer.lines.length === 0) {
      buffers.delete(serverId);
    }
  };
}

export function subscriberCount(serverId: string): number {
  return buffers.get(serverId)?.subscribers.size ?? 0;
}

export function clearConsole(serverId: string): void {
  const buffer = buffers.get(serverId);
  if (!buffer) return;
  buffer.lines = [];
}

export function dropConsole(serverId: string): void {
  buffers.delete(serverId);
}

/** Emits a panel-generated notice into the console, e.g. "Server starting". */
export function emitPanelNotice(serverId: string, message: string): ConsoleLine {
  return appendConsoleLine(serverId, 'panel', message);
}
