'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS, type Permission } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  permissions: string[];
  expiresAt: string;
  revokedAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Sensible starting point: read-only plus power control. */
const DEFAULT_PERMISSIONS: Permission[] = ['server:read', 'server:power', 'server:console.read'];

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [selected, setSelected] = useState<Permission[]>(DEFAULT_PERMISSIONS);
  const [created, setCreated] = useState<{ secret: string; prefix: string } | null>(null);

  async function load() {
    try {
      const result = await api.get<{ keys: ApiKey[] }>('/api-keys');
      setKeys(result.keys);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load API keys.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ secret: string; key: { prefix: string } }>('/api-keys', {
        label,
        permissions: selected,
        serverIds: [],
        expiresInDays,
        allowedCidrs: [],
      });
      setCreated({ secret: result.secret, prefix: result.key.prefix });
      setShowForm(false);
      setLabel('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.delete(`/api-keys/${id}`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke the key.');
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-extrabold uppercase tracking-wide">API keys</h1>
          <p className="text-sm text-ink-800">For the HTTP API.</p>
        </div>
        {!showForm ? (
          <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
            New key
          </button>
        ) : null}
      </div>

      {created ? (
        <div className="card border-power-start/40">
          <h2 className="text-sm font-bold text-power-start">Key created</h2>
          <p className="mt-1 text-xs text-ink-800">
            Copy it now — only its hash is stored, so it cannot be shown again.
          </p>
          <code className="mt-3 block break-all rounded bg-ink-200 p-3 font-mono text-xs select-all">
            {created.secret}
          </code>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => void navigator.clipboard?.writeText(created.secret)}
            >
              Copy
            </button>
            <button type="button" className="btn-ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={create} className="card space-y-4">
          <div>
            <label className="label" htmlFor="label">
              Label
            </label>
            <input
              id="label"
              className="input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={64}
              required
              autoFocus
            />
          </div>

          <div>
            <label className="label" htmlFor="expiry">
              Expires in (days)
            </label>
            <input
              id="expiry"
              type="number"
              className="input"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              min={1}
              max={365}
              required
            />
            <p className="mt-1.5 text-xs text-ink-700">Every key expires. There is no never option.</p>
          </div>

          <div>
            <span className="label">Permissions</span>
            <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto rounded-lg bg-ink-200 p-3 sm:grid-cols-2">
              {PERMISSIONS.map((permission) => (
                <label
                  key={permission}
                  className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-900"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(permission)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, permission]
                          : previous.filter((p) => p !== permission),
                      )
                    }
                    className="accent-brand-500"
                  />
                  <span className="font-mono">{permission}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={busy || !label || selected.length === 0}
            >
              {busy ? 'Creating…' : 'Create key'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="card h-24 animate-pulse bg-ink-200" />
      ) : keys.length === 0 && !showForm ? (
        <div className="card text-center text-sm text-ink-800">No API keys yet.</div>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div key={key.id} className="card flex items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-bold">{key.label}</span>
                  {key.revokedAt ? (
                    <span className="badge bg-power-stop/20 text-power-stop">revoked</span>
                  ) : key.expired ? (
                    <span className="badge bg-power-restart/20 text-power-restart">expired</span>
                  ) : (
                    <span className="badge bg-power-start/20 text-power-start">active</span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-ink-700">
                  {key.prefix}… · {key.permissions.length} permissions · expires{' '}
                  {new Date(key.expiresAt).toLocaleDateString()}
                </p>
              </div>
              {!key.revokedAt ? (
                <button
                  type="button"
                  className="btn-ghost h-8 px-3 text-[11px] text-power-stop"
                  onClick={() => void revoke(key.id)}
                >
                  Revoke
                </button>
              ) : null}
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
