'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GAMES, formatMemory, formatStorage, type GameId, type ServerState } from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { StateBadge } from '@/components/panel/StateBadge';

interface ServerSummary {
  id: string;
  name: string;
  game: GameId;
  state: ServerState;
  location: string;
  slots: number;
  playersOnline: number;
  address: string;
  suspended: boolean;
  suspendReason: string | null;
  resources: {
    cpuCores: number;
    memoryMib: number;
    storageGib: number;
    bandwidthMbps: number;
    slots: number;
  };
  useRelay: boolean;
}

export default function ServersPage() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = () =>
      api
        .get<{ servers: ServerSummary[] }>('/servers')
        .then((result) => {
          if (!cancelled) setServers(result.servers);
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof ApiError ? caught.message : 'Could not load your servers.');
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

    void load();
    // Poll so state changes from the supervisor show up without a refresh.
    const timer = setInterval(() => void load(), 10_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold uppercase tracking-wide">Your servers</h1>
          <p className="text-sm text-ink-800">
            {servers.length} server{servers.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link href="/panel/servers/new" className="btn-primary">
          Create server
        </Link>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="card h-40 animate-pulse bg-ink-200" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <div className="card text-center">
          <h2 className="text-lg font-bold">No servers yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-800">
            Create your first Arma Reforger or Arma 3 server. It runs in its own isolated container
            with exactly the CPU, memory and storage you allocate.
          </p>
          <Link href="/panel/servers/new" className="btn-primary mt-6">
            Create your first server
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <Link key={server.id} href={`/panel/servers/${server.id}`} className="card-hover block">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* truncate: server names are user-supplied and can be long. */}
                  <h2 className="truncate font-bold">{server.name}</h2>
                  <p className="text-xs text-ink-700">
                    {GAMES[server.game].name}
                    {server.location ? ` · ${server.location}` : ''}
                  </p>
                </div>
                <StateBadge state={server.state} suspended={server.suspended} />
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-ink-700">Players</dt>
                  <dd className="font-semibold">
                    {server.playersOnline}/{server.slots}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-700">CPU</dt>
                  <dd className="font-semibold">{server.resources.cpuCores}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-700">RAM</dt>
                  <dd className="font-semibold">{formatMemory(server.resources.memoryMib)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-700">Disk</dt>
                  <dd className="font-semibold">{formatStorage(server.resources.storageGib)}</dd>
                </div>
              </dl>

              <div className="mt-3 flex items-center justify-between border-t border-ink-300 pt-3">
                <code className="truncate font-mono text-[11px] text-ink-800">{server.address}</code>
                {server.useRelay ? (
                  <span className="badge bg-power-reinstall/15 text-power-reinstall">Relay</span>
                ) : null}
              </div>

              {server.suspended && server.suspendReason ? (
                <p className="mt-2 text-[11px] leading-relaxed text-power-restart">
                  {server.suspendReason}
                </p>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
