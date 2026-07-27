'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  GAMES,
  GAME_IDS,
  CONFIG_FIELDS,
  RESOURCE_LIMITS,
  formatMemory,
  formatStorage,
  type GameId,
} from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { ConfigForm } from '@/components/panel/ConfigForm';

/**
 * Create a server.
 *
 * The sliders are bounded by the platform limits, and the API re-checks every
 * value against real node capacity - the form cannot be used to oversell.
 */

interface NodeOption {
  id: string;
  name: string;
  region: string;
  locationLabel: string;
  relayEnabled: boolean;
  capacity: {
    cpuAvailable: number;
    memoryMibAvailable: number;
    storageGibAvailable: number;
  };
}

export default function NewServerPage() {
  const router = useRouter();

  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Array<{ path: string; message: string }>>([]);

  const [name, setName] = useState('');
  const [game, setGame] = useState<GameId>('reforger');
  const [nodeId, setNodeId] = useState('');
  const [cpuCores, setCpuCores] = useState(RESOURCE_LIMITS.cpu.default);
  const [memoryGb, setMemoryGb] = useState(RESOURCE_LIMITS.memoryMib.default / 1024);
  const [storageGib, setStorageGib] = useState(RESOURCE_LIMITS.storageGib.default);
  const [bandwidthMbps, setBandwidthMbps] = useState(RESOURCE_LIMITS.bandwidthMbps.default);
  const [transferQuotaGib, setTransferQuotaGib] = useState(0);
  const [slots, setSlots] = useState(RESOURCE_LIMITS.slots.default);
  const [autoPortForward, setAutoPortForward] = useState(true);
  const [useRelay, setUseRelay] = useState(false);
  // Settings chosen here are merged over the game's defaults on the server, so
  // an empty object is the same as not touching this section at all.
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    api
      .get<{ nodes: NodeOption[] }>('/nodes')
      .then((result) => {
        setNodes(result.nodes);
        if (result.nodes[0]) setNodeId(result.nodes[0].id);
      })
      .catch((caught) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load nodes.');
      })
      .finally(() => setLoading(false));
  }, []);

  const selectedNode = nodes.find((node) => node.id === nodeId);
  const definition = GAMES[game];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      const result = await api.post<{ server: { id: string } }>('/servers', {
        name,
        game,
        nodeId,
        resources: {
          cpuCores,
          cpuSet: null,
          memoryMib: memoryGb * 1024,
          storageGib,
          bandwidthMbps,
          transferQuotaGib,
          slots,
        },
        autoPortForward,
        useRelay,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
      router.push(`/panel/servers/${result.server.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setDetails(caught.details ?? []);
      } else {
        setError('The server could not be created.');
      }
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-500 border-t-brand-500" />
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="card mx-auto max-w-lg text-center">
        <h1 className="text-lg font-bold">No nodes available</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-800">
          A node must be registered and passing the host requirements check before servers can be
          created.
        </p>
        <Link href="/setup" className="btn-primary mt-6">
          Open setup
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-ink-700">
        <Link href="/panel" className="hover:text-white">
          Servers
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-900">New</span>
      </nav>

      <form onSubmit={submit} className="space-y-4">
        {/* ---- Basics ---- */}
        <section className="card space-y-4">
          <h1 className="text-lg font-extrabold uppercase tracking-wide">Create a server</h1>

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
              required
              autoFocus
            />
          </div>

          <div>
            <span className="label">Game</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {GAME_IDS.map((id) => {
                const candidate = GAMES[id];
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!candidate.released}
                    onClick={() => {
                      setGame(id);
                      setSlots(Math.min(slots, candidate.maxSlots));
                      // The settings belong to the game they were chosen for.
                      setConfig({});
                    }}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      game === id
                        ? 'border-brand-500 bg-brand-500/10'
                        : 'border-ink-400 hover:border-ink-500'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <div className="text-sm font-bold">{candidate.shortName}</div>
                    <div className="text-[11px] text-ink-700">
                      {candidate.released ? `up to ${candidate.maxSlots} slots` : 'not released yet'}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="node">
              Node
            </label>
            <select
              id="node"
              className="input"
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
            >
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.locationLabel} ({node.name})
                </option>
              ))}
            </select>
            {selectedNode ? (
              <p className="mt-1.5 text-xs text-ink-700">
                Free: {selectedNode.capacity.cpuAvailable.toFixed(1)} cores ·{' '}
                {formatMemory(selectedNode.capacity.memoryMibAvailable)} ·{' '}
                {formatStorage(selectedNode.capacity.storageGibAvailable)}
              </p>
            ) : null}
          </div>
        </section>

        {/* ---- Resources ---- */}
        <section className="card space-y-5">
          <h2 className="text-sm font-bold uppercase tracking-wide">Resources</h2>

          <Slider
            label="CPU"
            value={cpuCores}
            min={RESOURCE_LIMITS.cpu.min}
            max={RESOURCE_LIMITS.cpu.max}
            step={RESOURCE_LIMITS.cpu.step}
            display={`${cpuCores} ${cpuCores === 1 ? 'core' : 'cores'}`}
            onChange={setCpuCores}
          />

          <Slider
            label="Memory"
            value={memoryGb}
            min={RESOURCE_LIMITS.memoryMib.min / 1024}
            max={RESOURCE_LIMITS.memoryMib.max / 1024}
            step={1}
            display={`${memoryGb} GB`}
            onChange={setMemoryGb}
            note={`${definition.name} needs at least ${definition.memoryMib.min / 1024} GB`}
          />

          <Slider
            label="Storage"
            value={storageGib}
            min={RESOURCE_LIMITS.storageGib.min}
            max={1024}
            step={10}
            display={formatStorage(storageGib)}
            onChange={setStorageGib}
          />

          <Slider
            label="Bandwidth"
            value={bandwidthMbps}
            min={RESOURCE_LIMITS.bandwidthMbps.min}
            max={1000}
            step={RESOURCE_LIMITS.bandwidthMbps.step}
            display={`${bandwidthMbps} Mbps`}
            onChange={setBandwidthMbps}
          />

          <Slider
            label="Monthly transfer"
            value={transferQuotaGib}
            min={0}
            max={10000}
            step={100}
            display={transferQuotaGib === 0 ? 'unmetered' : `${transferQuotaGib} GB`}
            onChange={setTransferQuotaGib}
          />

          <Slider
            label="Player slots"
            value={slots}
            min={RESOURCE_LIMITS.slots.min}
            max={definition.maxSlots}
            step={1}
            display={`${slots} slots`}
            onChange={setSlots}
          />
        </section>

        {/* ---- Networking ---- */}
        <section className="card space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide">Networking</h2>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-900">
            <input
              type="checkbox"
              checked={autoPortForward}
              onChange={(event) => setAutoPortForward(event.target.checked)}
              className="mt-0.5 accent-brand-500"
            />
            <span>
              <strong>Open ports automatically</strong> — tries NAT-PMP, then PCP, then UPnP against
              your router, and renews the lease so the server does not drop off mid-session.
            </span>
          </label>

          <label
            className={`flex items-start gap-2 text-xs leading-relaxed ${
              selectedNode?.relayEnabled ? 'cursor-pointer text-ink-900' : 'cursor-not-allowed text-ink-700'
            }`}
          >
            <input
              type="checkbox"
              checked={useRelay}
              disabled={!selectedNode?.relayEnabled}
              onChange={(event) => setUseRelay(event.target.checked)}
              className="mt-0.5 accent-brand-500"
            />
            <span>
              <strong>Route through the relay</strong> — players see the relay address instead of
              yours, and it works behind carrier-grade NAT.
              {!selectedNode?.relayEnabled ? ' Not configured on this node.' : ''}
            </span>
          </label>

          {!useRelay ? (
            <p className="rounded-md bg-power-restart/10 p-2.5 text-[11px] leading-relaxed text-power-restart">
              Without the relay, players connect directly and can see this connection&apos;s public IP
              address.
            </p>
          ) : null}
        </section>

        {CONFIG_FIELDS[game].length > 0 ? (
          <div className="rounded-lg border border-ink-400 p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setShowConfig((v) => !v)}
            >
              <span className="text-sm font-bold">Game settings</span>
              <span className="text-xs text-ink-700">
                {showConfig ? 'Hide' : 'Optional — sensible defaults are used'}
              </span>
            </button>

            {showConfig ? (
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-ink-700">
                  Anything left alone uses {definition.name}&apos;s default. Every one of these can
                  also be changed later under Settings, so nothing here is a decision you are stuck
                  with.
                </p>
                <ConfigForm
                  fields={CONFIG_FIELDS[game]}
                  config={config}
                  onChange={setConfig}
                  invalidPaths={details.map((detail) => detail.path)}
                  disabled={busy}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <button type="submit" className="btn-primary w-full" disabled={busy || name.length < 3}>
          {busy ? 'Creating…' : 'Create server'}
        </button>

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
      </form>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  note,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  note?: string;
  onChange: (value: number) => void;
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
      {note ? <p className="mt-1 text-[11px] text-ink-700">{note}</p> : null}
    </div>
  );
}
