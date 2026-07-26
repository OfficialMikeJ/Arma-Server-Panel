'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { RESOURCE_LIMITS, formatMemory, formatStorage } from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

/**
 * Server settings.
 *
 * The game config is edited as JSON rather than a generated form: each title
 * has a different schema, and a hand-rolled form per game would drift out of
 * sync with the adapter. The API validates every key against the game's own
 * schema and returns field-level errors, which are shown inline.
 */
export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

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

  const [configText, setConfigText] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Array<{ path: string; message: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{
        server: {
          name: string;
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
      setConfigText(JSON.stringify(server.config, null, 2));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [id]);

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

  async function saveConfig() {
    setBusy('config');
    setError(null);
    setDetails([]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(configText);
    } catch {
      setError('That is not valid JSON.');
      setBusy(null);
      return;
    }

    try {
      const result = await api.patch<{ config: unknown }>(`/servers/${id}/config`, parsed);
      setConfigText(JSON.stringify(result.config, null, 2));
      setNotice('Configuration saved. Restart to apply.');
    } catch (caught) {
      fail(caught, 'Could not save the configuration.');
    } finally {
      setBusy(null);
    }
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
        <h2 className="text-sm font-bold uppercase tracking-wide">Game configuration</h2>
        <p className="text-xs leading-relaxed text-ink-700">
          Validated against this game&apos;s own schema. Invalid keys or out-of-range values are
          rejected with the exact field named.
        </p>
        <textarea
          className="input h-80 font-mono text-[12px] leading-relaxed"
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
          spellCheck={false}
        />
        <button type="button" className="btn-primary w-full" onClick={() => void saveConfig()} disabled={busy !== null}>
          {busy === 'config' ? 'Saving…' : 'Save configuration'}
        </button>
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
