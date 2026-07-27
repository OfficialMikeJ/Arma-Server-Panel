'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONFIG_FIELDS, RESOURCE_LIMITS, formatMemory, formatStorage, type GameId } from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';
import { ConfigForm } from '@/components/panel/ConfigForm';

/**
 * Server settings.
 *
 * The game config has two interchangeable views: a generated form, and the raw
 * JSON. The form is built from CONFIG_FIELDS in the shared package rather than
 * hand-written per game, because a hand-written one drifts out of sync with the
 * adapter's schema the first time a setting is added - a test in the API
 * enforces that they match.
 *
 * The JSON editor is never taken away. Some settings (mission rotation, mission
 * headers) are structures no set of controls describes well, and an operator
 * who knows the format should not have to go through a form to reach them.
 *
 * Either way the API validates every key against the game's own schema and
 * returns field-level errors, which are shown inline and mark the control.
 */
export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [name, setName] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [autoRestart, setAutoRestart] = useState(true);
  const [crashRestartLimit, setCrashRestartLimit] = useState(5);

  const [cpuCores, setCpuCores] = useState(4);
  const [memoryGb, setMemoryGb] = useState(8);
  const [storageGib, setStorageGib] = useState(60);
  const [bandwidthMbps, setBandwidthMbps] = useState(100);
  const [transferQuotaGib, setTransferQuotaGib] = useState(0);
  const [slots, setSlots] = useState(32);

  const [gameId, setGameId] = useState<GameId>('arma3');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [configText, setConfigText] = useState('{}');
  const [configMode, setConfigMode] = useState<'form' | 'json'>('form');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Array<{ path: string; message: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [purgeData, setPurgeData] = useState(true);

  const fields = CONFIG_FIELDS[gameId] ?? [];
  // A game with no descriptors only ever shows the JSON editor, so the saved
  // payload has to come from the text - not from the form object the operator
  // never saw. Derived rather than stored, so the two can never disagree.
  const effectiveMode = fields.length > 0 ? configMode : 'json';

  /** Keeps the form object and the JSON text as two views of one value. */
  const applyConfig = useCallback((value: unknown) => {
    const object =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    setConfig(object);
    setConfigText(JSON.stringify(object, null, 2));
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{
        server: {
          name: string;
          game: GameId;
          autoStart: boolean;
          autoRestart: boolean;
          crashRestartLimit: number;
          config: unknown;
          resources: {
            cpuCores: number;
            memoryMib: number;
            storageGib: number;
            bandwidthMbps: number;
            transferQuotaGib: number;
            slots: number;
          };
        };
      }>(`/servers/${id}`);

      const server = result.server;
      setName(server.name);
      setAutoStart(server.autoStart);
      setAutoRestart(server.autoRestart);
      setCrashRestartLimit(server.crashRestartLimit);
      setCpuCores(server.resources.cpuCores);
      setMemoryGb(server.resources.memoryMib / 1024);
      setStorageGib(server.resources.storageGib);
      setBandwidthMbps(server.resources.bandwidthMbps);
      setTransferQuotaGib(server.resources.transferQuotaGib);
      setSlots(server.resources.slots);
      setGameId(server.game);
      applyConfig(server.config);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [id, applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(caught: unknown, fallback: string) {
    if (caught instanceof ApiError) {
      setError(caught.message);
      setDetails(caught.details ?? []);
    } else {
      setError(fallback);
    }
  }

  async function saveGeneral() {
    setBusy('general');
    setError(null);
    setDetails([]);
    setNotice(null);
    try {
      await api.patch(`/servers/${id}`, { name, autoStart, autoRestart, crashRestartLimit });
      setNotice('Saved.');
    } catch (caught) {
      fail(caught, 'Could not save.');
    } finally {
      setBusy(null);
    }
  }

  async function saveResources() {
    setBusy('resources');
    setError(null);
    setDetails([]);
    setNotice(null);
    try {
      await api.patch(`/servers/${id}/resources`, {
        cpuCores,
        cpuSet: null,
        memoryMib: memoryGb * 1024,
        storageGib,
        bandwidthMbps,
        transferQuotaGib,
        slots,
      });
      setNotice('Resources updated. Restart for CPU and memory to take effect.');
    } catch (caught) {
      fail(caught, 'Could not update resources.');
    } finally {
      setBusy(null);
    }
  }

  async function deleteServer() {
    setBusy('delete');
    setError(null);
    setDetails([]);
    setNotice(null);
    try {
      // The API requires the typed name too - this is not a client-side-only
      // guard, so a stray API call cannot delete a server either.
      await api.delete(`/servers/${id}`, { confirmation: deleteConfirm, purgeData });
      router.push('/panel');
      router.refresh();
    } catch (caught) {
      fail(caught, 'The server could not be deleted.');
      setBusy(null);
    }
  }

  async function saveConfig() {
    setBusy('config');
    setError(null);
    setDetails([]);
    setNotice(null);

    // Whichever view is open is the one being saved. The other is regenerated
    // from whatever the server returns, so the two can never disagree.
    let payload: unknown;
    if (effectiveMode === 'json') {
      try {
        payload = JSON.parse(configText);
      } catch {
        setError('That is not valid JSON.');
        setBusy(null);
        return;
      }
    } else {
      payload = config;
    }

    try {
      const result = await api.patch<{ config: unknown }>(`/servers/${id}/config`, payload);
      applyConfig(result.config);
      setNotice('Configuration saved. Restart to apply.');
    } catch (caught) {
      fail(caught, 'Could not save the configuration.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Switches view, carrying the current edits across.
   *
   * Moving to JSON re-serialises the form object. Moving back parses the text,
   * and refuses if it is not valid - silently discarding what someone typed
   * because a brace was missing would be worse than making them fix it.
   */
  function switchConfigMode(next: 'form' | 'json') {
    if (next === effectiveMode) return;

    if (next === 'json') {
      setConfigText(JSON.stringify(config, null, 2));
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(configText);
      } catch {
        setError('The JSON is not valid, so it cannot be shown as a form yet.');
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('The configuration must be a JSON object.');
        return;
      }
      setConfig(parsed as Record<string, unknown>);
    }

    setError(null);
    setConfigMode(next);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <ServerTabs serverId={id} />
        <div className="card h-64 animate-pulse bg-ink-200" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />
      <h1 className="text-lg font-extrabold uppercase tracking-wide">Settings</h1>

      {/* ---- General ---- */}
      <section className="card space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-wide">General</h2>

        <div>
          <label className="label" htmlFor="name">
            Server name
          </label>
          <input
            id="name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={3}
            maxLength={64}
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(event) => setAutoStart(event.target.checked)}
            className="accent-brand-500"
          />
          Start automatically when the panel starts
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={autoRestart}
            onChange={(event) => setAutoRestart(event.target.checked)}
            className="accent-brand-500"
          />
          Restart automatically after a crash
        </label>

        <div>
          <label className="label" htmlFor="crashLimit">
            Crash restart limit (0 = unlimited)
          </label>
          <input
            id="crashLimit"
            type="number"
            className="input"
            value={crashRestartLimit}
            onChange={(event) => setCrashRestartLimit(Number(event.target.value))}
            min={0}
            max={20}
          />
          <p className="mt-1 text-[11px] text-ink-700">
            Stops a server that crashes on startup from restarting forever.
          </p>
        </div>

        <button type="button" className="btn-primary w-full" onClick={() => void saveGeneral()} disabled={busy !== null}>
          {busy === 'general' ? 'Saving…' : 'Save general settings'}
        </button>
      </section>

      {/* ---- Resources ---- */}
      <section className="card space-y-5">
        <h2 className="text-sm font-bold uppercase tracking-wide">Resources</h2>

        <Slider label="CPU" value={cpuCores} min={RESOURCE_LIMITS.cpu.min} max={RESOURCE_LIMITS.cpu.max}
          step={RESOURCE_LIMITS.cpu.step} display={`${cpuCores} cores`} onChange={setCpuCores} />
        <Slider label="Memory" value={memoryGb} min={RESOURCE_LIMITS.memoryMib.min / 1024}
          max={RESOURCE_LIMITS.memoryMib.max / 1024} step={1} display={formatMemory(memoryGb * 1024)}
          onChange={setMemoryGb} />
        <Slider label="Storage" value={storageGib} min={RESOURCE_LIMITS.storageGib.min} max={1024}
          step={10} display={formatStorage(storageGib)} onChange={setStorageGib} />
        <Slider label="Bandwidth" value={bandwidthMbps} min={RESOURCE_LIMITS.bandwidthMbps.min}
          max={1000} step={RESOURCE_LIMITS.bandwidthMbps.step} display={`${bandwidthMbps} Mbps`}
          onChange={setBandwidthMbps} />
        <Slider label="Monthly transfer" value={transferQuotaGib} min={0} max={10000} step={100}
          display={transferQuotaGib === 0 ? 'unmetered' : `${transferQuotaGib} GB`}
          onChange={setTransferQuotaGib} />
        <Slider label="Player slots" value={slots} min={RESOURCE_LIMITS.slots.min}
          max={RESOURCE_LIMITS.slots.max} step={1} display={`${slots} slots`} onChange={setSlots} />

        <button type="button" className="btn-primary w-full" onClick={() => void saveResources()} disabled={busy !== null}>
          {busy === 'resources' ? 'Saving…' : 'Save resources'}
        </button>
      </section>

      {/* ---- Game config ---- */}
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide">Game configuration</h2>

          {fields.length > 0 ? (
            <div className="flex rounded-md border border-ink-300 p-0.5" role="tablist">
              {(['form', 'json'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={configMode === mode}
                  className={`rounded px-3 py-1 text-xs font-semibold uppercase tracking-wide transition ${
                    configMode === mode
                      ? 'bg-brand-500 text-ink-100'
                      : 'text-ink-700 hover:text-ink-900'
                  }`}
                  onClick={() => switchConfigMode(mode)}
                >
                  {mode === 'form' ? 'Settings' : 'JSON'}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <p className="text-xs leading-relaxed text-ink-700">
          {fields.length === 0
            ? 'This game has no guided settings yet, so its configuration is edited directly.'
            : 'Both views edit the same configuration. Whichever is open is what gets saved.'}{' '}
          Everything is validated against this game&apos;s own schema — invalid keys or out-of-range
          values are rejected with the exact field named.
        </p>

        {effectiveMode === 'form' ? (
          <ConfigForm
            fields={fields}
            config={config}
            onChange={setConfig}
            invalidPaths={details.map((detail) => detail.path)}
            disabled={busy !== null}
          />
        ) : (
          <textarea
            className="input h-80 font-mono text-[12px] leading-relaxed"
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            spellCheck={false}
            aria-label="Game configuration as JSON"
          />
        )}

        <button type="button" className="btn-primary w-full" onClick={() => void saveConfig()} disabled={busy !== null}>
          {busy === 'config' ? 'Saving…' : 'Save configuration'}
        </button>
      </section>

      {/* ---- Delete ---- */}
      <section className="card border-power-stop/40">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-power-stop">
          Delete this server
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-800">
          Stops and removes the container, releases its ports, and deletes every file belonging to
          it — configs, mods, saves and logs. This cannot be undone.
        </p>

        {!showDelete ? (
          <button type="button" className="btn-stop" onClick={() => setShowDelete(true)}>
            Delete server
          </button>
        ) : (
          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-900">
              <input
                type="checkbox"
                checked={purgeData}
                onChange={(event) => setPurgeData(event.target.checked)}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                Also delete the server&apos;s files. Untick to keep them on disk and only remove the
                container and its database record.
              </span>
            </label>

            <div>
              <label className="label" htmlFor="delete-confirm">
                Type <span className="font-mono text-brand-400">{name}</span> to confirm
              </label>
              <input
                id="delete-confirm"
                className="input"
                value={deleteConfirm}
                onChange={(event) => setDeleteConfirm(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn-stop flex-1"
                disabled={deleteConfirm !== name || busy !== null}
                onClick={() => void deleteServer()}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowDelete(false);
                  setDeleteConfirm('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {notice ? (
        <p className="rounded-md bg-power-start/10 p-3 text-sm text-power-start">{notice}</p>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          <p>{error}</p>
          {details.length > 0 ? (
            <ul className="mt-1.5 list-inside list-disc text-xs">
              {details.map((detail) => (
                <li key={detail.path}>
                  {detail.path}: {detail.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Slider({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (value: number) => void;
}) {
  const id = `slider-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-800" htmlFor={id}>
          {label}
        </label>
        <span className="font-mono text-sm font-bold text-brand-500">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-brand-500"
      />
    </div>
  );
}
