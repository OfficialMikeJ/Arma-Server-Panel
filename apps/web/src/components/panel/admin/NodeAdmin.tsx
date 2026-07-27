'use client';

import { useState } from 'react';
import { formatMemory, formatStorage, PORT_ALLOCATION } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Node administration: capacity, port ranges, and adding a node.
 *
 * Capacity is measured on the machine, never taken from this form - an operator
 * cannot declare 64 GB on an 8 GB box and sell it. The form therefore only
 * carries identity and networking; everything else is detected.
 */

export interface NodeRow {
  id: string;
  name: string;
  region: string;
  locationLabel: string;
  status: string;
  publicHost: string;
  staticPublicHost: boolean;
  portRange: { start: number; end: number };
  requirementsPass: boolean;
  hardware: {
    cpuThreads: number;
    memoryMib: number;
    storageGib: number;
    downloadMbps: number;
    uploadMbps: number;
  };
  capacity: { cpuAvailable: number; memoryMibAvailable: number; storageGibAvailable: number };
}

interface Props {
  nodes: NodeRow[];
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}

export function NodeAdmin({ nodes, canWrite, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function recheck(nodeId: string) {
    setBusy(nodeId);
    try {
      await api.post(`/admin/nodes/${nodeId}/recheck`);
      await onChanged();
    } catch (caught) {
      onError(caught, 'The requirements check failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Nodes</h2>
        {canWrite ? (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add node'}
          </button>
        ) : null}
      </div>

      {adding ? (
        <AddNodeForm
          onDone={async () => {
            setAdding(false);
            await onChanged();
          }}
          onError={onError}
        />
      ) : null}

      {nodes.length === 0 ? (
        <div className="card text-center text-sm text-ink-800">No nodes registered.</div>
      ) : (
        nodes.map((node) => (
          <div key={node.id} className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-bold">{node.locationLabel}</span>
                <span className="ml-2 text-xs text-ink-700">
                  {node.name} · {node.region}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`badge ${
                    node.status === 'ONLINE'
                      ? 'bg-power-start/20 text-power-start'
                      : 'bg-power-restart/20 text-power-restart'
                  }`}
                >
                  {node.status}
                </span>
                {!node.requirementsPass ? (
                  <span className="badge bg-power-stop/20 text-power-stop">below minimum</span>
                ) : null}
                {node.staticPublicHost ? (
                  <span className="badge bg-brand-500/20 text-brand-400">static address</span>
                ) : null}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <Stat label="CPU" value={`${node.capacity.cpuAvailable.toFixed(1)} / ${node.hardware.cpuThreads}`} />
              <Stat label="Memory free" value={formatMemory(node.capacity.memoryMibAvailable)} />
              <Stat label="Storage free" value={formatStorage(node.capacity.storageGibAvailable)} />
              <Stat label="Link" value={`${node.hardware.downloadMbps}/${node.hardware.uploadMbps} Mbps`} />
              <Stat label="Address" value={node.publicHost} />
              <Stat label="Port range" value={`${node.portRange.start}–${node.portRange.end}`} />
            </dl>

            {editing === node.id ? (
              <PortRangeForm
                node={node}
                onDone={async () => {
                  setEditing(null);
                  await onChanged();
                }}
                onCancel={() => setEditing(null)}
                onError={onError}
              />
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className="btn-secondary flex-1"
                  onClick={() => void recheck(node.id)}
                  disabled={busy !== null || !canWrite}
                >
                  {busy === node.id ? 'Measuring…' : 'Re-run requirements check'}
                </button>
                {canWrite ? (
                  <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(node.id)}>
                    Edit ports &amp; address
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function PortRangeForm({
  node,
  onDone,
  onCancel,
  onError,
}: {
  node: NodeRow;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [start, setStart] = useState(node.portRange.start);
  const [end, setEnd] = useState(node.portRange.end);
  const [publicHost, setPublicHost] = useState(node.publicHost);
  const [staticHost, setStaticHost] = useState(node.staticPublicHost);
  const [saving, setSaving] = useState(false);

  // Caught here as well as server-side so the operator is told before the round
  // trip, not after.
  const invalid =
    end <= start
      ? 'The end of the range must be above its start.'
      : start < PORT_ALLOCATION.min
        ? `The panel does not allocate below ${PORT_ALLOCATION.min}.`
        : end > PORT_ALLOCATION.max
          ? `The panel does not allocate above ${PORT_ALLOCATION.max}.`
          : null;

  async function save() {
    if (invalid) return;
    setSaving(true);
    try {
      await api.patch(`/admin/nodes/${node.id}`, {
        portRangeStart: start,
        portRangeEnd: end,
        publicHost: publicHost.trim(),
        staticPublicHost: staticHost,
      });
      await onDone();
    } catch (caught) {
      onError(caught, 'Could not update the node.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-ink-300 p-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`start-${node.id}`}>
            Port range start
          </label>
          <input
            id={`start-${node.id}`}
            type="number"
            className="input"
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </div>
        <div>
          <label className="label" htmlFor={`end-${node.id}`}>
            Port range end
          </label>
          <input
            id={`end-${node.id}`}
            type="number"
            className="input"
            value={end}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </div>
      </div>

      <p className="text-xs leading-relaxed text-ink-700">
        Existing servers keep the block they were given. This only changes where new ones are
        placed, and each title still starts in its own band — Arma 3 from 2302, Reforger from 2001.
      </p>

      <div>
        <label className="label" htmlFor={`host-${node.id}`}>
          Public address
        </label>
        <input
          id={`host-${node.id}`}
          className="input"
          value={publicHost}
          spellCheck={false}
          onChange={(event) => setPublicHost(event.target.value)}
        />
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-900">
        <input
          type="checkbox"
          checked={staticHost}
          onChange={(event) => setStaticHost(event.target.checked)}
          className="mt-0.5 accent-brand-500"
        />
        <span>
          This address is fixed
          <span className="mt-0.5 block text-xs text-ink-700">
            A static IP, or a DNS name you control. The panel stops trying to rediscover it, and
            verifies a port you forwarded by hand rather than reporting it as a failed mapping.
          </span>
        </span>
      </label>

      {invalid ? <p className="text-xs text-power-stop">{invalid}</p> : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() => void save()}
          disabled={saving || invalid !== null}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AddNodeForm({
  onDone,
  onError,
}: {
  onDone: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [dockerEndpoint, setDockerEndpoint] = useState('/var/run/docker.sock');
  const [dataRoot, setDataRoot] = useState('');
  const [start, setStart] = useState<number>(PORT_ALLOCATION.min);
  const [end, setEnd] = useState<number>(PORT_ALLOCATION.max);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setSaving(true);
    setNotice(null);
    try {
      await api.post('/admin/nodes/local', {
        name: name.trim(),
        region: region.trim(),
        locationLabel: locationLabel.trim(),
        dockerEndpoint: dockerEndpoint.trim(),
        ...(dataRoot.trim() ? { dataRoot: dataRoot.trim() } : {}),
        ...(publicHost.trim() ? { publicHost: publicHost.trim() } : {}),
        portRangeStart: start,
        portRangeEnd: end,
      });
      await onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'host_requirements_not_met') {
        setNotice(caught.message);
      } else {
        onError(caught, 'Could not register the node.');
      }
    } finally {
      setSaving(false);
    }
  }

  const ready = name.trim().length >= 2 && region.trim().length >= 2 && locationLabel.trim().length >= 2;

  return (
    <div className="card space-y-3 border-brand-500/40">
      <h3 className="text-sm font-bold">Add a node</h3>
      <p className="text-xs leading-relaxed text-ink-700">
        Registers the machine this API is running on. CPU, memory, storage and throughput are
        measured here rather than entered — a node that does not meet the minimum requirements is
        refused. To add a <em>different</em> machine, run the installer there and point it at a
        remote Docker endpoint.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="node-name" label="Name" value={name} onChange={setName} placeholder="node-1" />
        <Field id="node-region" label="Region" value={region} onChange={setRegion} placeholder="eu-west" />
        <Field
          id="node-location"
          label="Location label"
          value={locationLabel}
          onChange={setLocationLabel}
          placeholder="London"
        />
        <Field
          id="node-host"
          label="Public address"
          value={publicHost}
          onChange={setPublicHost}
          placeholder="auto-detect if empty"
        />
        <Field
          id="node-docker"
          label="Docker endpoint"
          value={dockerEndpoint}
          onChange={setDockerEndpoint}
        />
        <Field
          id="node-root"
          label="Data root"
          value={dataRoot}
          onChange={setDataRoot}
          placeholder="uses DATA_ROOT if empty"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="node-start">
            Port range start
          </label>
          <input
            id="node-start"
            type="number"
            className="input"
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </div>
        <div>
          <label className="label" htmlFor="node-end">
            Port range end
          </label>
          <input
            id="node-end"
            type="number"
            className="input"
            value={end}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </div>
      </div>

      {notice ? (
        <p className="rounded-md bg-power-stop/10 p-3 text-xs leading-relaxed text-power-stop">{notice}</p>
      ) : null}

      <button
        type="button"
        className="btn-primary w-full"
        onClick={() => void create()}
        disabled={saving || !ready}
      >
        {saving ? 'Measuring the host…' : 'Register node'}
      </button>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-700">{label}</dt>
      <dd className="font-mono text-ink-900">{value}</dd>
    </div>
  );
}
