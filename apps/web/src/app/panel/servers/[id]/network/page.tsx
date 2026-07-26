'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

interface NetworkState {
  address: string;
  useRelay: boolean;
  autoPortForward: boolean;
  relayAvailable: boolean;
  behindCgnat: boolean;
  availableMethods: { natpmp: boolean; pcp: boolean; upnp: boolean; relay: boolean };
  ports: Array<{
    key: string;
    protocol: string;
    external: number;
    method: string;
    active: boolean;
    reachable: boolean | null;
    message: string | null;
  }>;
  privacyNote: string;
}

interface ForwardResult {
  results: Array<{ portKey: string; externalPort: number; success: boolean; message: string }>;
  summary: { opened: number; total: number; exposesHostIp: boolean };
  warning: string | null;
}

export default function NetworkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [state, setState] = useState<NetworkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForwardResult | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.get<NetworkState>(`/servers/${id}/network`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load networking.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function forward(preferred: 'auto' | 'relay' | 'upnp' | 'natpmp' | 'pcp') {
    setBusy('forward');
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<ForwardResult>(`/servers/${id}/network/forward`, { preferred }));
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Port opening failed.');
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy('verify');
    setError(null);
    try {
      await api.post(`/servers/${id}/network/verify`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Verification failed.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleRelay(useRelay: boolean) {
    setBusy('relay');
    setError(null);
    try {
      await api.patch(`/servers/${id}/network`, { useRelay });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change networking mode.');
    } finally {
      setBusy(null);
    }
  }

  if (loading || !state) {
    return (
      <div className="space-y-4">
        <ServerTabs serverId={id} />
        <div className="card h-48 animate-pulse bg-ink-200" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />

      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-extrabold uppercase tracking-wide">Network</h1>
        <code className="font-mono text-xs text-ink-800">{state.address}</code>
      </div>

      {state.behindCgnat ? (
        <div className="rounded-md border border-power-stop/40 bg-power-stop/10 p-3 text-sm leading-relaxed text-power-stop">
          Your ISP places this connection behind carrier-grade NAT. No router setting can open an
          inbound port through it — relay mode is the only way to make this server reachable.
        </div>
      ) : null}

      {/* ---- Mode ---- */}
      <section className="card space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide">Mode</h2>

        <label
          className={`flex items-start gap-2 text-sm leading-relaxed ${
            state.relayAvailable ? 'cursor-pointer text-ink-900' : 'cursor-not-allowed text-ink-700'
          }`}
        >
          <input
            type="checkbox"
            checked={state.useRelay}
            disabled={!state.relayAvailable || busy !== null}
            onChange={(event) => void toggleRelay(event.target.checked)}
            className="mt-1 accent-brand-500"
          />
          <span>
            <strong>Route through the relay</strong> — players see the relay address instead of
            yours, and it works behind carrier-grade NAT.
          </span>
        </label>

        {!state.relayAvailable ? (
          <div className="rounded-md border border-ink-400 bg-ink-200 p-3 text-xs leading-relaxed text-ink-800">
            <p className="mb-2 font-semibold text-ink-950">No relay is configured yet.</p>
            <p className="mb-2">
              A relay has to run somewhere with a public IP address — it is the address players
              connect to, so it cannot live on this machine behind the same router. Any small VPS
              will do; it only forwards UDP and stores nothing.
            </p>
            <pre className="mb-2 overflow-x-auto rounded bg-ink-100 p-2 font-mono text-[11px]">
{`# on the public host
git clone https://github.com/OfficialMikeJ/Arma-Server-Panel.git
cd Arma-Server-Panel
RELAY_PUBLIC_HOST=relay.example.com \\
RELAY_TOKEN=$(openssl rand -hex 32) \\
  docker compose -f docker-compose.relay.yml up -d --build \\
  && docker compose -f docker-compose.relay.yml up -d`}
            </pre>
            <p>
              Then add <code className="font-mono text-brand-400">RELAY_ENABLED=true</code>,{' '}
              <code className="font-mono text-brand-400">RELAY_ENDPOINT</code> and the same{' '}
              <code className="font-mono text-brand-400">RELAY_TOKEN</code> to this panel&apos;s{' '}
              <code className="font-mono text-brand-400">.env</code> and restart it.
            </p>
          </div>
        ) : null}

        <p
          className={`rounded-md p-3 text-xs leading-relaxed ${
            state.useRelay
              ? 'bg-power-start/10 text-power-start'
              : 'bg-power-restart/10 text-power-restart'
          }`}
        >
          {state.privacyNote}
        </p>
      </section>

      {/* ---- Actions ---- */}
      <section className="card space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide">Open ports</h2>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => void forward('auto')} disabled={busy !== null}>
            {busy === 'forward' ? 'Working…' : 'Open automatically'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void verify()} disabled={busy !== null}>
            {busy === 'verify' ? 'Checking…' : 'Verify from outside'}
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {Object.entries(state.availableMethods).map(([method, available]) => (
            <span
              key={method}
              className={`badge ${
                available ? 'bg-power-start/15 text-power-start' : 'bg-ink-300 text-ink-700'
              }`}
            >
              {method} {available ? 'available' : 'no'}
            </span>
          ))}
        </div>

        {result ? (
          <div className="space-y-2 rounded-md bg-ink-200 p-3">
            <p className="text-xs font-semibold">
              {result.summary.opened} of {result.summary.total} ports opened.
            </p>
            <ul className="space-y-1 text-[11px] leading-relaxed">
              {result.results.map((entry) => (
                <li
                  key={`${entry.portKey}-${entry.externalPort}`}
                  className={entry.success ? 'text-power-start' : 'text-power-stop'}
                >
                  {entry.success ? '✓' : '✕'} {entry.portKey} ({entry.externalPort}) — {entry.message}
                </li>
              ))}
            </ul>
            {result.warning ? (
              <p className="text-[11px] leading-relaxed text-power-restart">{result.warning}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ---- Ports ---- */}
      <section className="card">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide">Ports</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-700">
              <tr>
                <th scope="col" className="pb-2 pr-4 font-semibold">Port</th>
                <th scope="col" className="pb-2 pr-4 font-semibold">External</th>
                <th scope="col" className="pb-2 pr-4 font-semibold">Method</th>
                <th scope="col" className="pb-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-300">
              {state.ports.map((port) => (
                <tr key={`${port.key}-${port.protocol}`}>
                  <td className="py-2 pr-4 font-semibold capitalize">{port.key}</td>
                  <td className="py-2 pr-4 font-mono">
                    {port.external}/{port.protocol}
                  </td>
                  <td className="py-2 pr-4 uppercase text-ink-800">{port.method}</td>
                  <td className="py-2">
                    {port.reachable === true ? (
                      <span className="text-power-start">Reachable</span>
                    ) : port.active ? (
                      <span className="text-power-restart">Mapped, unverified</span>
                    ) : (
                      <span className="text-ink-700">Not open</span>
                    )}
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
