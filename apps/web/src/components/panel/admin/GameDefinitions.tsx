'use client';

import { useState } from 'react';
import type { GameDefinition } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Game definitions.
 *
 * A definition describes how to obtain and launch one game's dedicated server,
 * as data. Adding a game is uploading one of these rather than editing the
 * panel.
 *
 * The format is declarative on purpose - there is no install-script field,
 * because an uploaded shell script would be remote code execution wearing a
 * config file. Worth saying on the screen too, so nobody goes looking for the
 * field and assumes it is missing by accident.
 */

export interface StoredDefinition {
  definition: GameDefinition;
  builtIn: boolean;
  enabled: boolean;
  overridesBuiltIn: boolean;
  uploadedBy: string | null;
  updatedAt: string | null;
}

interface Props {
  definitions: StoredDefinition[];
  placeholders: readonly string[];
  onChanged: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}

export function GameDefinitions({ definitions, placeholders, onChanged, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(slug: string, enabled: boolean) {
    setBusy(slug);
    try {
      await api.patch(`/admin/game-definitions/${slug}`, { enabled });
      await onChanged();
    } catch (caught) {
      onError(caught, 'Could not change that definition.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(slug: string) {
    setBusy(slug);
    try {
      await api.delete(`/admin/game-definitions/${slug}`);
      await onChanged();
    } catch (caught) {
      onError(caught, 'Could not remove that definition.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Games</h2>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '+ Add a game'}
        </button>
      </div>

      <p className="text-xs leading-relaxed text-ink-700">
        Each game is described by a JSON definition: which image to run, which Steam app to
        download, which ports it needs. There is deliberately no install-script field — the panel
        performs the install itself from what the definition states, so uploading one cannot run
        arbitrary commands on this machine.
      </p>

      {adding ? (
        <DefinitionEditor
          placeholders={placeholders}
          onSaved={async () => {
            setAdding(false);
            await onChanged();
          }}
          onError={onError}
        />
      ) : null}

      {definitions.map((entry) => (
        <div key={entry.definition.id} className="card space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-bold">{entry.definition.name}</span>
              <span className="ml-2 font-mono text-xs text-ink-700">
                {entry.definition.id} · v{entry.definition.version}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {entry.builtIn ? <span className="badge bg-ink-300 text-ink-900">built-in</span> : null}
              {entry.overridesBuiltIn ? (
                <span className="badge bg-power-restart/20 text-power-restart">overridden</span>
              ) : null}
              {!entry.definition.adapter ? (
                <span className="badge bg-power-restart/20 text-power-restart">no adapter</span>
              ) : null}
              <span
                className={`badge ${
                  entry.enabled ? 'bg-power-start/20 text-power-start' : 'bg-ink-300 text-ink-700'
                }`}
              >
                {entry.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <Stat label="Image" value={entry.definition.install.image} />
            <Stat label="Steam app" value={String(entry.definition.install.steamAppId)} />
            <Stat
              label="Ports"
              value={`${entry.definition.ports.length}, stride ${entry.definition.portStride}`}
            />
            <Stat
              label="Login"
              value={entry.definition.install.requiresSteamLogin ? 'required' : 'anonymous'}
            />
          </dl>

          {!entry.definition.adapter ? (
            <p className="text-xs leading-relaxed text-ink-700">
              No adapter, so the panel installs and runs this game but writes no config file, cannot
              report a player count, and cannot send console commands to it.
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => void toggle(entry.definition.id, !entry.enabled)}
              disabled={busy !== null}
            >
              {entry.enabled ? 'Disable' : 'Enable'}
            </button>
            {entry.updatedAt ? (
              <button
                type="button"
                className="btn-stop"
                onClick={() => void remove(entry.definition.id)}
                disabled={busy !== null}
              >
                {entry.overridesBuiltIn ? 'Revert to built-in' : 'Delete'}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function DefinitionEditor({
  placeholders,
  onSaved,
  onError,
}: {
  placeholders: readonly string[];
  onSaved: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [text, setText] = useState(EXAMPLE);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<Array<{ path: string; message: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);

  function parse(): unknown | null {
    try {
      return JSON.parse(text);
    } catch (caught) {
      setProblems([
        { path: '(root)', message: caught instanceof Error ? caught.message : 'Not valid JSON.' },
      ]);
      setWarnings([]);
      setChecked(true);
      return null;
    }
  }

  async function check() {
    const parsed = parse();
    if (parsed === null) return;

    setChecking(true);
    try {
      const result = await api.post<{
        valid: boolean;
        problems: Array<{ path: string; message: string }>;
        warnings: string[];
      }>('/admin/game-definitions/validate', parsed);
      setProblems(result.problems);
      setWarnings(result.warnings);
      setChecked(true);
    } catch (caught) {
      onError(caught, 'Could not check that definition.');
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    const parsed = parse();
    if (parsed === null) return;

    setSaving(true);
    try {
      await api.post('/admin/game-definitions', parsed);
      await onSaved();
    } catch (caught) {
      // Field-level problems come back as details; show them where the other
      // problems go rather than as one opaque line.
      if (caught instanceof ApiError && caught.details?.length) {
        setProblems(caught.details);
        setChecked(true);
      } else {
        onError(caught, 'Could not save that definition.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card space-y-3 border-brand-500/40">
      <h3 className="text-sm font-bold">New game definition</h3>

      <p className="text-xs leading-relaxed text-ink-700">
        Startup arguments may use these placeholders:{' '}
        <span className="font-mono text-ink-900">
          {placeholders.map((name) => `{{${name}}}`).join(' ')}
        </span>
        . They are passed to the process as a list, not through a shell.
      </p>

      <textarea
        className="input h-96 font-mono text-[12px] leading-relaxed"
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setChecked(false);
        }}
        aria-label="Game definition JSON"
      />

      {checked && problems.length === 0 ? (
        <p className="rounded-md bg-power-start/10 p-3 text-xs text-power-start">
          Valid. {warnings.length === 0 ? 'No warnings.' : ''}
        </p>
      ) : null}

      {problems.length > 0 ? (
        <ul className="space-y-1 rounded-md bg-power-stop/10 p-3 text-xs text-power-stop">
          {problems.map((problem, index) => (
            <li key={`${problem.path}-${index}`}>
              <span className="font-mono">{problem.path}</span> — {problem.message}
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md bg-power-restart/10 p-3 text-xs text-power-restart">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-secondary flex-1" onClick={() => void check()} disabled={checking || saving}>
          {checking ? 'Checking…' : 'Check'}
        </button>
        <button type="button" className="btn-primary flex-1" onClick={() => void save()} disabled={checking || saving}>
          {saving ? 'Saving…' : 'Save definition'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-700">{label}</dt>
      <dd className="truncate font-mono text-ink-900">{value}</dd>
    </div>
  );
}

/** A complete, valid starting point rather than an empty box. */
const EXAMPLE = JSON.stringify(
  {
    id: 'my-game',
    name: 'My Game',
    shortName: 'MyGame',
    version: '1',
    author: '',
    description: 'A dedicated server installed from Steam.',
    install: {
      image: 'asp/steamcmd:latest',
      steamAppId: 123456,
      steamGameAppId: null,
      requiresSteamLogin: false,
      branch: null,
      branchPassword: null,
      validate: true,
      binary: 'MyGameServer',
    },
    startup: {
      arguments: ['-port={{gamePort}}', '-maxplayers={{slots}}', '-config={{configFile}}'],
      stopTimeoutSeconds: 30,
    },
    ports: [
      { key: 'game', label: 'Game', protocol: 'udp', offset: 0, public: true },
      { key: 'query', label: 'Query', protocol: 'udp', offset: 1, public: true },
    ],
    portStride: 10,
    resources: {
      minMemoryMib: 2048,
      recommendedMemoryMib: 4096,
      minCpuCores: 1,
      minStorageGib: 10,
    },
    defaultSlots: 32,
    maxSlots: 64,
    adapter: null,
  },
  null,
  2,
);
