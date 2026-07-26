'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  GAMES,
  formatBytes,
  formatMemory,
  formatStorage,
  type GameId,
  type Permission,
  type ServerState,
} from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { PowerControls } from '@/components/panel/PowerControls';
import { ServerConsole } from '@/components/panel/ServerConsole';
import { StateBadge } from '@/components/panel/StateBadge';

/**
 * Server detail.
 *
 * Layout follows the brief: the server header and its coloured power buttons
 * sit at the top, and the full console sits directly below so an admin can
 * watch what happens the moment they press a button.
 */

interface ServerDetail {
  id: string;
  name: string;
  game: GameId;
  state: ServerState;
  address: string;
  location: string;
  slots: number;
  playersOnline: number;
  suspended: boolean;
  suspendReason: string | null;
  useRelay: boolean;
  crashCount: number;
  resources: {
    cpuCores: number;
    memoryMib: number;
    storageGib: number;
    bandwidthMbps: number;
    transferQuotaGib: number;
    slots: number;
  };
  ports: Array<{
    key: string;
    protocol: string;
    external: number;
    method: string;
    active: boolean;
    reachable: boolean | null;
    public: boolean;
    message: string | null;
  }>;
}

interface DetailResponse {
  server: ServerDetail;
  permissions: Permission[];
  role: string;
}

interface CurrentMetrics {
  state: string;
  playersOnline: number;
  slots: number;
  current: {
    cpuPercent: number;
    cpuLimitPercent: number;
    memoryBytes: number;
    memoryLimitBytes: number;
    netRxBytes: number;
    netTxBytes: number;
    fps: number | null;
  } | null;
}

export default function ServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [metrics, setMetrics] = useState<CurrentMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<DetailResponse>(`/servers/${id}`);
      setDetail(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this server.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    const poll = () =>
      api
        .get<CurrentMetrics>(`/servers/${id}/metrics/current`)
        .then((result) => {
          if (!cancelled) setMetrics(result);
        })
        .catch(() => undefined);

    void poll();
    const timer = setInterval(() => void poll(), 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="card h-32 animate-pulse bg-ink-200" />
        <div className="card h-[520px] animate-pulse bg-ink-200" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="card text-center">
        <h1 className="text-lg font-bold">Server unavailable</h1>
        <p className="mt-2 text-sm text-ink-800">{error ?? 'Not found.'}</p>
        <Link href="/panel" className="btn-secondary mt-6">
          Back to servers
        </Link>
      </div>
    );
  }

  const { server, permissions, role } = detail;
  const can = (permission: Permission) => permissions.includes(permission);
  const game = GAMES[server.game];

  const cpuPercent = metrics?.current
    ? Math.min(100, (metrics.current.cpuPercent / Math.max(1, metrics.current.cpuLimitPercent)) * 100)
    : 0;
  const memoryPercent = metrics?.current
    ? Math.min(100, (metrics.current.memoryBytes / Math.max(1, metrics.current.memoryLimitBytes)) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* ---- Breadcrumb ---- */}
      <nav aria-label="Breadcrumb" className="text-xs text-ink-700">
        <Link href="/panel" className="hover:text-white">
          Servers
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink-900">{server.name}</span>
      </nav>

      {/* ---- Header + power controls ---- */}
      <section className="card">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-extrabold">{server.name}</h1>
              <StateBadge state={server.state} suspended={server.suspended} />
              <span className="badge bg-ink-300 text-ink-900">{role}</span>
            </div>
            <p className="mt-1 text-sm text-ink-800">
              {game.name}
              {server.location ? ` · ${server.location}` : ''} · {server.playersOnline}/{server.slots}{' '}
              players
            </p>
          </div>

          <div className="flex items-center gap-2">
            <code className="rounded bg-ink-200 px-3 py-1.5 font-mono text-xs">{server.address}</code>
            <button
              type="button"
              className="btn-ghost h-8 px-2 text-[11px]"
              onClick={() => {
                void navigator.clipboard?.writeText(server.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {server.suspended ? (
          <p className="mb-4 rounded-md border border-power-restart/40 bg-power-restart/10 p-3 text-sm text-power-restart">
            {server.suspendReason ?? 'This server is suspended.'}
          </p>
        ) : null}

        {server.crashCount > 0 && server.state === 'crashed' ? (
          <p className="mb-4 rounded-md border border-power-stop/40 bg-power-stop/10 p-3 text-sm text-power-stop">
            This server has crashed {server.crashCount} time{server.crashCount === 1 ? '' : 's'}.
            Check the console below, or ask the AI assistant to look at it.
          </p>
        ) : null}

        <PowerControls
          serverId={server.id}
          serverName={server.name}
          state={server.state}
          canPower={can('server:power') && !server.suspended}
          canReinstall={can('server:reinstall') && !server.suspended}
          onStateChange={(state) => {
            setDetail((previous) =>
              previous ? { ...previous, server: { ...previous.server, state } } : previous,
            );
            // Re-read shortly after: transitions settle asynchronously.
            setTimeout(() => void load(), 2500);
          }}
        />
      </section>

      {/* ---- Live resource usage ---- */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Gauge
          label="CPU"
          value={`${(metrics?.current?.cpuPercent ?? 0).toFixed(1)}%`}
          sub={`of ${server.resources.cpuCores} cores`}
          percent={cpuPercent}
        />
        <Gauge
          label="Memory"
          value={formatBytes(metrics?.current?.memoryBytes ?? 0)}
          sub={`of ${formatMemory(server.resources.memoryMib)}`}
          percent={memoryPercent}
        />
        <Gauge
          label="Storage"
          value={formatStorage(server.resources.storageGib)}
          sub="allocated"
          percent={null}
        />
        <Gauge
          label="Network"
          value={`${server.resources.bandwidthMbps} Mbps`}
          sub={
            server.resources.transferQuotaGib > 0
              ? `${server.resources.transferQuotaGib} GB/month`
              : 'unmetered'
          }
          percent={null}
        />
      </section>

      {/* ---- Console, directly below the server ---- */}
      {can('server:console.read') ? (
        <ServerConsole serverId={server.id} canWrite={can('server:console.write')} />
      ) : null}

      {/* ---- Ports ---- */}
      <section className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wide">Network</h2>
          {can('server:network') ? (
            <Link href={`/panel/servers/${server.id}/network`} className="btn-ghost h-7 px-2 text-[11px]">
              Manage
            </Link>
          ) : null}
        </div>

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
              {server.ports.map((port) => (
                <tr key={`${port.key}-${port.protocol}`}>
                  <td className="py-2 pr-4 font-semibold capitalize">{port.key}</td>
                  <td className="py-2 pr-4 font-mono">
                    {port.external}/{port.protocol}
                  </td>
                  <td className="py-2 pr-4 uppercase text-ink-800">{port.method}</td>
                  <td className="py-2">
                    {!port.public ? (
                      <span className="text-ink-700">Internal only</span>
                    ) : port.reachable === true ? (
                      <span className="text-power-start">Reachable</span>
                    ) : port.active ? (
                      <span className="text-power-restart">Mapped, unverified</span>
                    ) : (
                      <span className="text-power-stop">Not open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-ink-700">
          {server.useRelay
            ? 'Traffic is routed through the relay, so players see the relay address rather than yours.'
            : 'Players connect directly, which means they can see this connection’s public IP address. Enable relay mode under Manage to keep it private.'}
        </p>
      </section>

      {/* ---- Section links ---- */}
      <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Server tools">
        {[
          { href: 'mods', label: 'Mods', permission: 'server:read' as Permission },
          { href: 'files', label: 'Files', permission: 'server:files.read' as Permission },
          { href: 'settings', label: 'Settings', permission: 'server:settings' as Permission },
          { href: 'ai', label: 'AI assistant', permission: 'server:ai' as Permission },
        ]
          .filter((item) => can(item.permission))
          .map((item) => (
            <Link
              key={item.href}
              href={`/panel/servers/${server.id}/${item.href}`}
              className="card-hover text-center text-sm font-bold"
            >
              {item.label}
            </Link>
          ))}
      </nav>
    </div>
  );
}

function Gauge({
  label,
  value,
  sub,
  percent,
}: {
  label: string;
  value: string;
  sub: string;
  percent: number | null;
}) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-700">{label}</div>
      <div className="mt-1 text-lg font-extrabold">{value}</div>
      <div className="text-[11px] text-ink-700">{sub}</div>
      {percent !== null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-300">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              percent > 90 ? 'bg-power-stop' : percent > 70 ? 'bg-power-restart' : 'bg-brand-500'
            }`}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
