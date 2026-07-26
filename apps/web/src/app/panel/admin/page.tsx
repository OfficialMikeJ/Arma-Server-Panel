'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBytes, formatMemory, formatStorage } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Platform administration: nodes and the audit trail.
 *
 * Every route behind this needs an *elevated* session, which expires after
 * 20 minutes idle. A 403 with `step_up_required` means re-proving TOTP.
 */

interface NodeRow {
  id: string;
  name: string;
  region: string;
  locationLabel: string;
  status: string;
  publicHost: string;
  requirementsPass: boolean;
  requirementsCheckedAt: string | null;
  hardware: {
    cpuThreads: number;
    memoryMib: number;
    storageGib: number;
    downloadMbps: number;
    uploadMbps: number;
  };
  capacity: {
    cpuAvailable: number;
    memoryMibAvailable: number;
    storageGibAvailable: number;
  };
}

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: { type: string; id: string | null } | null;
  outcome: string;
}

export default function AdminPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [code, setCode] = useState('');
  const [chain, setChain] = useState<{ valid: boolean; checked: number; brokenAtId: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [nodeResult, auditResult] = await Promise.all([
        api.get<{ nodes: NodeRow[] }>('/admin/nodes'),
        api.get<{ entries: AuditRow[] }>('/admin/audit?limit=50'),
      ]);
      setNodes(nodeResult.nodes);
      setAudit(auditResult.entries);
      setStepUpNeeded(false);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setStepUpNeeded(true);
        setError(null);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not load administration.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function stepUp(event: React.FormEvent) {
    event.preventDefault();
    setBusy('stepup');
    setError(null);
    try {
      await api.post('/auth/admin/step-up', { code: code.trim() });
      setCode('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
    } finally {
      setBusy(null);
    }
  }

  async function recheck(nodeId: string) {
    setBusy(nodeId);
    setError(null);
    try {
      await api.post(`/admin/nodes/${nodeId}/recheck`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The check failed.');
    } finally {
      setBusy(null);
    }
  }

  async function verifyChain() {
    setBusy('chain');
    setError(null);
    try {
      setChain(await api.post('/admin/audit/verify'));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Verification failed.');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="card h-48 animate-pulse bg-ink-200" />;

  if (stepUpNeeded) {
    return (
      <div className="mx-auto max-w-md">
        <form onSubmit={stepUp} className="card space-y-4">
          <div>
            <h1 className="text-lg font-bold">Re-authenticate</h1>
            <p className="mt-1 text-sm leading-relaxed text-ink-800">
              Administrative actions need an elevated session, which expires after 20 minutes of
              inactivity. Enter a code from your authenticator.
            </p>
          </div>
          <input
            className="input text-center font-mono text-xl tracking-[0.4em]"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            autoFocus
            required
          />
          <button type="submit" className="btn-primary w-full" disabled={busy !== null || code.length !== 6}>
            {busy === 'stepup' ? 'Verifying…' : 'Elevate session'}
          </button>
          {error ? (
            <p role="alert" className="text-sm text-power-stop">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-extrabold uppercase tracking-wide">Administration</h1>

      {/* ---- Nodes ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Nodes</h2>

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
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <Stat label="CPU" value={`${node.capacity.cpuAvailable.toFixed(1)} / ${node.hardware.cpuThreads}`} />
                <Stat
                  label="Memory free"
                  value={formatMemory(node.capacity.memoryMibAvailable)}
                />
                <Stat
                  label="Storage free"
                  value={formatStorage(node.capacity.storageGibAvailable)}
                />
                <Stat
                  label="Link"
                  value={`${node.hardware.downloadMbps}/${node.hardware.uploadMbps} Mbps`}
                />
              </dl>

              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() => void recheck(node.id)}
                disabled={busy !== null}
              >
                {busy === node.id ? 'Measuring…' : 'Re-run requirements check'}
              </button>
            </div>
          ))
        )}
      </section>

      {/* ---- Audit ---- */}
      <section className="card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide">Audit trail</h2>
          <button
            type="button"
            className="btn-ghost h-8 px-3 text-[11px]"
            onClick={() => void verifyChain()}
            disabled={busy !== null}
          >
            {busy === 'chain' ? 'Verifying…' : 'Verify integrity'}
          </button>
        </div>

        {chain ? (
          <p
            className={`mb-3 rounded-md p-3 text-xs ${
              chain.valid
                ? 'bg-power-start/10 text-power-start'
                : 'bg-power-stop/10 text-power-stop'
            }`}
          >
            {chain.valid
              ? `Hash chain intact across ${chain.checked} entries — no tampering detected.`
              : `Chain broken at entry ${chain.brokenAtId}. Entries after this point cannot be trusted.`}
          </p>
        ) : null}

        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-ink-100 text-ink-700">
              <tr>
                <th scope="col" className="pb-2 pr-3 font-semibold">When</th>
                <th scope="col" className="pb-2 pr-3 font-semibold">Actor</th>
                <th scope="col" className="pb-2 pr-3 font-semibold">Action</th>
                <th scope="col" className="pb-2 font-semibold">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-300">
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-700">
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3 truncate">{entry.actor}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px]">{entry.action}</td>
                  <td
                    className={`py-1.5 ${
                      entry.outcome === 'success'
                        ? 'text-ink-800'
                        : entry.outcome === 'denied'
                          ? 'text-power-restart'
                          : 'text-power-stop'
                    }`}
                  >
                    {entry.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-700">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
