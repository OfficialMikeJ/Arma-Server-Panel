'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { GAMES, type GameId, type ModEntry } from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

/**
 * Mod manager.
 *
 * Drag-free reordering (up/down buttons) because a drag interaction that only
 * works with a mouse would break the "admin from any device" promise.
 */
export default function ModsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [mods, setMods] = useState<ModEntry[]>([]);
  const [game, setGame] = useState<GameId>('reforger');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modId, setModId] = useState('');
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ mods: ModEntry[]; game: GameId }>(`/servers/${id}/mods`);
      setMods(result.mods);
      setGame(result.game);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load mods.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: ModEntry[]) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.put<{ mods: ModEntry[] }>(`/servers/${id}/mods`, {
        mods: next.map((mod, index) => ({ ...mod, order: index })),
      });
      setMods(result.mods);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the mod list.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addMod(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = modId.trim();
    if (!trimmed) return;

    await save([
      ...mods,
      {
        modId: trimmed,
        name: name.trim() || `Workshop item ${trimmed}`,
        version: null,
        enabled: true,
        order: mods.length,
        required: false,
        sizeBytes: null,
      },
    ]);
    setModId('');
    setName('');
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= mods.length) return;
    const next = [...mods];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    void save(next);
  }

  const definition = GAMES[game];
  const idHint =
    game === 'arma3'
      ? 'Steam Workshop file id, e.g. 463939057'
      : '16-character Reforger workshop id, e.g. 5965550F24A0C152';

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />

      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-extrabold uppercase tracking-wide">Mods</h1>
        <span className="text-xs text-ink-700">
          {mods.filter((mod) => mod.enabled).length} of {mods.length} enabled
        </span>
      </div>

      {definition.modSource === 'none' ? (
        <div className="card text-center text-sm text-ink-800">
          {definition.name} does not support mods through the panel yet.
        </div>
      ) : (
        <>
          <form onSubmit={addMod} className="card space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide">Add a mod</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="modId">
                  Mod id
                </label>
                <input
                  id="modId"
                  className="input font-mono"
                  value={modId}
                  onChange={(event) => setModId(event.target.value)}
                  placeholder={game === 'arma3' ? '463939057' : '5965550F24A0C152'}
                  required
                />
                <p className="mt-1 text-[11px] text-ink-700">{idHint}</p>
              </div>
              <div>
                <label className="label" htmlFor="modName">
                  Display name (optional)
                </label>
                <input
                  id="modName"
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={160}
                />
              </div>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy || !modId.trim()}>
              {busy ? 'Saving…' : 'Add to load order'}
            </button>
          </form>

          {loading ? (
            <div className="card h-32 animate-pulse bg-ink-200" />
          ) : mods.length === 0 ? (
            <div className="card text-center text-sm text-ink-800">No mods on this server.</div>
          ) : (
            <div className="card space-y-1 p-3">
              {mods.map((mod, index) => (
                <div
                  key={mod.modId}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-ink-200"
                >
                  <span className="w-6 shrink-0 text-center font-mono text-[11px] text-ink-700">
                    {index + 1}
                  </span>

                  <div className="flex shrink-0 flex-col gap-0.5">
                    <button
                      type="button"
                      aria-label={`Move ${mod.name} up`}
                      disabled={index === 0 || busy}
                      onClick={() => move(index, -1)}
                      className="rounded px-1 text-[10px] leading-none text-ink-700 hover:bg-ink-400 hover:text-white disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${mod.name} down`}
                      disabled={index === mods.length - 1 || busy}
                      onClick={() => move(index, 1)}
                      className="rounded px-1 text-[10px] leading-none text-ink-700 hover:bg-ink-400 hover:text-white disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm ${mod.enabled ? 'font-semibold' : 'text-ink-700'}`}>
                      {mod.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-700">
                      {mod.modId}
                      {mod.version ? ` · v${mod.version}` : ' · latest'}
                    </div>
                  </div>

                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-ink-800">
                    <input
                      type="checkbox"
                      checked={mod.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void save(
                          mods.map((entry) =>
                            entry.modId === mod.modId
                              ? { ...entry, enabled: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                      className="accent-brand-500"
                    />
                    on
                  </label>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save(mods.filter((entry) => entry.modId !== mod.modId))}
                    className="shrink-0 rounded px-2 py-1 text-[11px] font-semibold text-power-stop hover:bg-power-stop/10"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-center text-xs text-ink-700">
            Changes are written to the server&apos;s config immediately. Restart to apply them.
          </p>
        </>
      )}

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}
