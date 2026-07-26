'use client';

import { useEffect, useState } from 'react';
import { GAMES, GAME_IDS, type GameId } from '@asp/shared';
import { api, ApiError, API_BASE } from '@/lib/api';

interface Preset {
  id: string;
  name: string;
  game: GameId;
  modCount: number;
  updatedAt: string;
}

export default function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [game, setGame] = useState<GameId>('reforger');
  const [payload, setPayload] = useState('');
  const [format, setFormat] = useState<'arma3-html' | 'reforger-json' | 'asp-json'>('reforger-json');

  async function load() {
    try {
      const result = await api.get<{ presets: Preset[] }>('/mod-presets');
      setPresets(result.presets);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load presets.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function importPreset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await api.post<{ warnings: string[] }>('/mod-presets/import', {
        name,
        game,
        payload,
        format,
      });
      setWarnings(result.warnings ?? []);
      setName('');
      setPayload('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not import that preset.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/mod-presets/${id}`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the preset.');
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-extrabold uppercase tracking-wide">Mod presets</h1>
        <p className="text-sm text-ink-800">
          Import an Arma 3 Launcher HTML preset or a Reforger config, then apply it to any server.
        </p>
      </div>

      <form onSubmit={importPreset} className="card space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-wide">Import</h2>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="name">
              Preset name
            </label>
            <input
              id="name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="game">
              Game
            </label>
            <select
              id="game"
              className="input"
              value={game}
              onChange={(event) => {
                const next = event.target.value as GameId;
                setGame(next);
                setFormat(next === 'arma3' ? 'arma3-html' : 'reforger-json');
              }}
            >
              {GAME_IDS.filter((id) => GAMES[id].modSource !== 'none').map((id) => (
                <option key={id} value={id}>
                  {GAMES[id].name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="format">
            Format
          </label>
          <select
            id="format"
            className="input"
            value={format}
            onChange={(event) => setFormat(event.target.value as typeof format)}
          >
            <option value="arma3-html">Arma 3 Launcher preset (.html)</option>
            <option value="reforger-json">Reforger config or mod array (.json)</option>
            <option value="asp-json">Arma Server Panel preset (.json)</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="payload">
            Paste the file contents
          </label>
          <textarea
            id="payload"
            className="input h-40 font-mono text-[11px]"
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={busy || !name || !payload}>
          {busy ? 'Importing…' : 'Import preset'}
        </button>

        {warnings.length > 0 ? (
          <ul className="list-inside list-disc rounded-md bg-power-restart/10 p-3 text-xs text-power-restart">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </form>

      {loading ? (
        <div className="card h-24 animate-pulse bg-ink-200" />
      ) : presets.length === 0 ? (
        <div className="card text-center text-sm text-ink-800">No presets yet.</div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => (
            <div key={preset.id} className="card flex items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <span className="truncate font-bold">{preset.name}</span>
                <p className="mt-0.5 text-[11px] text-ink-700">
                  {GAMES[preset.game]?.name ?? preset.game} · {preset.modCount} mods
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <a
                  href={`${API_BASE}/api/v1/mod-presets/${preset.id}/export?format=${
                    preset.game === 'arma3' ? 'arma3-html' : 'asp-json'
                  }`}
                  className="btn-ghost h-8 px-3 text-[11px]"
                >
                  Export
                </a>
                <button
                  type="button"
                  className="btn-ghost h-8 px-3 text-[11px] text-power-stop"
                  onClick={() => void remove(preset.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}
