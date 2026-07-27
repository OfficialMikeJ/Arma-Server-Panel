'use client';

import { useState } from 'react';
import type { ServerState } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Server power controls.
 *
 * Colours are fixed by the brief and by convention:
 *   green = start, red = stop, yellow = restart, blue = reinstall.
 *
 * Colour alone never carries the meaning - each button also has a label and an
 * icon, so the controls remain usable for colour-blind operators.
 *
 * Reinstall is destructive, so it requires typing the server name, the same
 * pattern the API enforces server-side.
 */

interface Props {
  serverId: string;
  serverName: string;
  state: ServerState;
  canPower: boolean;
  canReinstall: boolean;
  onStateChange: (state: ServerState) => void;
}

type Action = 'start' | 'stop' | 'restart' | 'reinstall';

const TRANSITIONAL: ServerState[] = [
  'starting',
  'stopping',
  'restarting',
  'reinstalling',
  'installing',
  'creating',
  'deleting',
];

export function PowerControls({
  serverId,
  serverName,
  state,
  canPower,
  canReinstall,
  onStateChange,
}: Props) {
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [showReinstall, setShowReinstall] = useState(false);

  const busy = pending !== null || TRANSITIONAL.includes(state);
  const running = state === 'running';
  const offline = state === 'offline' || state === 'crashed';

  async function run(action: Action, confirmation?: string) {
    setPending(action);
    setError(null);
    try {
      const result = await api.post<{ state: ServerState }>(`/servers/${serverId}/power`, {
        action,
        ...(confirmation ? { confirmation } : {}),
      });
      onStateChange(result.state);
      setShowReinstall(false);
      setConfirmText('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // Field-level detail matters most here: a rejected power action is
        // usually a confirmation mismatch or a bad state transition.
        const detail = caught.details?.[0];
        setError(detail ? `${caught.message} (${detail.path}: ${detail.message})` : caught.message);
      } else {
        setError('That action could not be completed.');
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-start"
          disabled={!canPower || busy || !offline}
          onClick={() => void run('start')}
          title={running ? 'The server is already running' : 'Start the server'}
        >
          <PlayIcon />
          {pending === 'start' ? 'Starting…' : 'Start'}
        </button>

        <button
          type="button"
          className="btn-stop"
          disabled={!canPower || busy || !running}
          onClick={() => void run('stop')}
          title="Stop the server gracefully, giving it time to save"
        >
          <StopIcon />
          {pending === 'stop' ? 'Stopping…' : 'Stop'}
        </button>

        <button
          type="button"
          className="btn-restart"
          disabled={!canPower || busy || !running}
          onClick={() => void run('restart')}
          title="Restart the server"
        >
          <RestartIcon />
          {pending === 'restart' ? 'Restarting…' : 'Restart'}
        </button>

        <button
          type="button"
          className="btn-reinstall"
          disabled={!canReinstall || busy}
          onClick={() => setShowReinstall((value) => !value)}
          title="Replace the game files. Config, mods and saves are kept."
        >
          <ReinstallIcon />
          Reinstall
        </button>
      </div>

      {showReinstall ? (
        <div className="rounded-lg border border-power-reinstall/40 bg-power-reinstall/10 p-4">
          <p className="mb-1 text-sm font-semibold">Reinstall this server?</p>
          <p className="mb-3 text-xs leading-relaxed text-ink-900">
            Game files are deleted and downloaded again. Your configuration, mod list and saves are
            kept. The server will be offline while this runs.
          </p>
          <label className="label" htmlFor="reinstall-confirm">
            Type <span className="font-mono text-brand-400">{serverName}</span> to confirm
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="reinstall-confirm"
              className="input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn-reinstall shrink-0"
              disabled={confirmText !== serverName || busy}
              onClick={() => void run('reinstall', confirmText)}
            >
              {pending === 'reinstall' ? 'Reinstalling…' : 'Confirm reinstall'}
            </button>
            <button
              type="button"
              className="btn-secondary shrink-0"
              onClick={() => {
                setShowReinstall(false);
                setConfirmText('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---- Icons kept local so each button reads without colour ---- */

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  'aria-hidden': true,
} as const;

const PlayIcon = () => (
  <svg {...iconProps}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const StopIcon = () => (
  <svg {...iconProps}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

const RestartIcon = () => (
  <svg {...iconProps} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const ReinstallIcon = () => (
  <svg {...iconProps} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
