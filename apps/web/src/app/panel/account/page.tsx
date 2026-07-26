'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface AccountResponse {
  account: {
    id: string;
    username: string;
    type: string;
    status: string;
    isPlatformOwner: boolean;
    totpVerified: boolean;
    discord: { id: string; username: string | null } | null;
    createdAt: string;
  };
  security: {
    totpEnrolledAt: string | null;
    remainingRecoveryCodes: number;
    activeSessions: number;
    lastLoginAt: string | null;
  };
  servers: number;
}

export default function AccountPage() {
  const [data, setData] = useState<AccountResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setData(await api.get<AccountResponse>('/account'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your account.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function regenerate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/account/recovery-codes', {
        code: code.trim(),
      });
      setNewCodes(result.recoveryCodes);
      setCode('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    try {
      await api.post('/auth/logout-everywhere');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke sessions.');
    }
  }

  if (loading) return <div className="card h-40 animate-pulse bg-ink-200" />;
  if (!data) {
    return (
      <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
        {error}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-extrabold uppercase tracking-wide">Account</h1>

      <section className="card">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide">Profile</h2>
        <dl className="space-y-2 text-sm">
          <Row label="Username" value={data.account.username} />
          <Row label="Type" value={data.account.type} />
          <Row label="Status" value={data.account.status} />
          <Row
            label="Discord"
            value={data.account.discord ? (data.account.discord.username ?? 'linked') : 'not linked'}
          />
          <Row label="Servers" value={String(data.servers)} />
          <Row
            label="Member since"
            value={new Date(data.account.createdAt).toLocaleDateString()}
          />
        </dl>
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide">Security</h2>
        <dl className="space-y-2 text-sm">
          <Row
            label="Two-factor"
            value={data.account.totpVerified ? 'enrolled' : 'not enrolled'}
          />
          <Row
            label="Recovery codes left"
            value={String(data.security.remainingRecoveryCodes)}
          />
          <Row label="Active sessions" value={String(data.security.activeSessions)} />
          <Row
            label="Last sign-in"
            value={
              data.security.lastLoginAt
                ? new Date(data.security.lastLoginAt).toLocaleString()
                : 'never'
            }
          />
        </dl>

        <button type="button" className="btn-secondary mt-4 w-full" onClick={() => void signOutEverywhere()}>
          Sign out of all other sessions
        </button>
      </section>

      <section className="card">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide">Recovery codes</h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-700">
          Generating a new set invalidates the old one immediately. Requires a current authenticator
          code, so a stolen session cannot mint a permanent way in.
        </p>

        {newCodes ? (
          <>
            <ul className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-ink-200 p-4 font-mono text-xs">
              {newCodes.map((recoveryCode) => (
                <li key={recoveryCode} className="select-all">
                  {recoveryCode}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() => void navigator.clipboard?.writeText(newCodes.join('\n'))}
            >
              Copy
            </button>
          </>
        ) : (
          <form onSubmit={regenerate} className="flex gap-2">
            <input
              className="input font-mono"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              inputMode="numeric"
              maxLength={6}
              aria-label="Authenticator code"
              required
            />
            <button type="submit" className="btn-primary shrink-0" disabled={busy || code.length !== 6}>
              {busy ? 'Working…' : 'Regenerate'}
            </button>
          </form>
        )}
      </section>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-700">{label}</dt>
      <dd className="truncate font-semibold">{value}</dd>
    </div>
  );
}
