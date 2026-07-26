import type { ServerState } from '@asp/shared';

/**
 * Server state indicator.
 *
 * Every state carries a word as well as a colour, so the meaning survives for
 * colour-blind operators and in a screenshot pasted into a support ticket.
 */

const PRESENTATION: Record<ServerState, { label: string; className: string; pulse?: boolean }> = {
  creating: { label: 'Creating', className: 'bg-ink-400 text-ink-950', pulse: true },
  installing: { label: 'Installing', className: 'bg-power-reinstall/20 text-power-reinstall', pulse: true },
  offline: { label: 'Offline', className: 'bg-ink-400 text-ink-900' },
  starting: { label: 'Starting', className: 'bg-power-start/20 text-power-start', pulse: true },
  running: { label: 'Running', className: 'bg-power-start/20 text-power-start' },
  stopping: { label: 'Stopping', className: 'bg-power-restart/20 text-power-restart', pulse: true },
  restarting: { label: 'Restarting', className: 'bg-power-restart/20 text-power-restart', pulse: true },
  reinstalling: { label: 'Reinstalling', className: 'bg-power-reinstall/20 text-power-reinstall', pulse: true },
  crashed: { label: 'Crashed', className: 'bg-power-stop/20 text-power-stop' },
  suspended: { label: 'Suspended', className: 'bg-power-restart/20 text-power-restart' },
  deleting: { label: 'Deleting', className: 'bg-power-stop/20 text-power-stop', pulse: true },
};

export function StateBadge({
  state,
  suspended = false,
}: {
  state: ServerState;
  suspended?: boolean;
}) {
  const presentation = suspended ? PRESENTATION.suspended : PRESENTATION[state] ?? PRESENTATION.offline;

  return (
    <span className={`badge shrink-0 ${presentation.className}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${
          presentation.pulse ? 'animate-pulse' : ''
        }`}
        aria-hidden
      />
      {presentation.label}
    </span>
  );
}
