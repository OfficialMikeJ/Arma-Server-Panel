'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONSOLE_LIMITS, type ConsoleLine } from '@asp/shared';
import { consoleSocketUrl } from '@/lib/api';

/**
 * Live server console.
 *
 * Rendering notes that matter:
 *   * Lines are rendered as text nodes only. Server output contains player
 *     names and chat, which are attacker-controlled; there is no
 *     dangerouslySetInnerHTML anywhere in this component.
 *   * The API already strips ANSI escapes and control characters, and the
 *     `console-line` class forces wrapping so a very long line cannot break
 *     the layout.
 *   * The buffer is capped client-side too, so a chatty server cannot grow the
 *     DOM without bound.
 */

interface Props {
  serverId: string;
  canWrite: boolean;
}

type SocketState = 'connecting' | 'open' | 'closed' | 'error';

interface ServerMessage {
  type: 'hello' | 'line' | 'command_result' | 'error';
  line?: ConsoleLine;
  scrollback?: ConsoleLine[];
  canWrite?: boolean;
  response?: string;
  message?: string;
}

const STREAM_COLOUR: Record<string, string> = {
  stdout: 'text-ink-950',
  stderr: 'text-power-stop',
  rcon: 'text-power-reinstall',
  panel: 'text-brand-400',
};

export function ServerConsole({ serverId, canWrite }: Props) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [writable, setWritable] = useState(canWrite);

  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const appendLines = useCallback((incoming: ConsoleLine[]) => {
    setLines((previous) => {
      const next = [...previous, ...incoming];
      return next.length > CONSOLE_LIMITS.scrollbackLines
        ? next.slice(next.length - CONSOLE_LIMITS.scrollbackLines)
        : next;
    });
  }, []);

  /* ---- Connection, with exponential backoff ---- */
  const connect = useCallback(() => {
    if (socketRef.current) socketRef.current.close();

    setSocketState('connecting');
    const socket = new WebSocket(consoleSocketUrl(serverId));
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setSocketState('open');
      setError(null);
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (message.type) {
        case 'hello':
          if (message.scrollback) setLines(message.scrollback);
          if (typeof message.canWrite === 'boolean') setWritable(message.canWrite);
          break;
        case 'line':
          if (message.line) appendLines([message.line]);
          break;
        case 'command_result':
          if (message.response) {
            appendLines([
              {
                seq: Date.now(),
                at: new Date().toISOString(),
                stream: 'rcon',
                text: message.response,
              },
            ]);
          }
          break;
        case 'error':
          setError(message.message ?? 'The console reported an error.');
          break;
        default:
          break;
      }
    };

    socket.onerror = () => setSocketState('error');

    socket.onclose = (event) => {
      setSocketState('closed');
      // 1008 is a policy violation (not permitted / access revoked) - do not
      // hammer the server retrying something that will keep failing.
      if (event.code === 1008) {
        setError('The console closed: you no longer have access to this server.');
        return;
      }
      attemptRef.current += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attemptRef.current, 5));
      reconnectRef.current = setTimeout(connect, delay);
    };
  }, [serverId, appendLines]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  /* ---- Auto-scroll, unless the operator has scrolled up to read ---- */
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  function send() {
    const trimmed = command.trim();
    if (!trimmed || !writable) return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('The console is not connected.');
      return;
    }

    socketRef.current.send(JSON.stringify({ type: 'command', command: trimmed }));
    historyRef.current = [trimmed, ...historyRef.current].slice(0, 50);
    historyIndexRef.current = -1;
    setCommand('');
    setAutoScroll(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    // Shell-style history.
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(historyIndexRef.current + 1, historyRef.current.length - 1);
      if (next >= 0) {
        historyIndexRef.current = next;
        setCommand(historyRef.current[next] ?? '');
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = historyIndexRef.current - 1;
      historyIndexRef.current = next;
      setCommand(next >= 0 ? historyRef.current[next] ?? '' : '');
    }
  }

  const visible = useMemo(() => {
    if (!filter.trim()) return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, filter]);

  return (
    <section className="rounded-xl border border-ink-300 bg-ink-100" aria-label="Server console">
      {/* ---- Toolbar ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-300 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              socketState === 'open'
                ? 'bg-power-start'
                : socketState === 'connecting'
                  ? 'animate-pulse bg-power-restart'
                  : 'bg-power-stop'
            }`}
            aria-hidden
          />
          <h2 className="text-xs font-bold uppercase tracking-wide">Console</h2>
          <span className="text-[11px] text-ink-700">
            {socketState === 'open'
              ? `${lines.length} line${lines.length === 1 ? '' : 's'}`
              : socketState === 'connecting'
                ? 'connecting…'
                : 'reconnecting…'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter…"
            aria-label="Filter console output"
            className="h-7 w-32 rounded border border-ink-400 bg-ink-200 px-2 text-xs
                       placeholder:text-ink-700 focus:border-brand-500 focus:outline-none sm:w-44"
          />
          <button
            type="button"
            onClick={() => setLines([])}
            className="rounded px-2 py-1 text-[11px] font-semibold uppercase text-ink-800 hover:bg-ink-300 hover:text-white"
          >
            Clear
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-800">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => setAutoScroll(event.target.checked)}
              className="accent-brand-500"
            />
            Follow
          </label>
        </div>
      </div>

      {/* ---- Output ---- */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="h-[420px] overflow-y-auto bg-ink-50 p-3"
      >
        {visible.length === 0 ? (
          <p className="console-line text-ink-700">
            {filter ? 'No lines match that filter.' : 'Waiting for output…'}
          </p>
        ) : (
          visible.map((line) => (
            <div key={`${line.seq}-${line.at}`} className="console-line">
              <span className="mr-2 select-none text-ink-600">
                {new Date(line.at).toLocaleTimeString([], { hour12: false })}
              </span>
              {/* Text node only - never innerHTML. */}
              <span className={STREAM_COLOUR[line.stream] ?? 'text-ink-950'}>{line.text}</span>
            </div>
          ))
        )}
      </div>

      {/* ---- Command input ---- */}
      <div className="border-t border-ink-300 p-3">
        {writable ? (
          <div className="flex gap-2">
            <span className="flex select-none items-center font-mono text-sm text-brand-500">&gt;</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={CONSOLE_LIMITS.maxCommandLength}
              placeholder="Send an RCON command…"
              aria-label="Console command"
              autoComplete="off"
              spellCheck={false}
              className="input font-mono text-[13px]"
            />
            <button type="button" onClick={send} disabled={!command.trim()} className="btn-primary shrink-0">
              Send
            </button>
          </div>
        ) : (
          <p className="text-xs text-ink-700">
            You have read-only access to this console.
          </p>
        )}

        {error ? (
          <p role="alert" className="mt-2 text-xs text-power-stop">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
