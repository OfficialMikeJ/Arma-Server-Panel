'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * Steam credentials for downloading paid dedicated-server packages.
 *
 * Arma 3's server package is not free, so SteamCMD needs an account that owns
 * the game. Reforger's is free and needs nothing here.
 *
 * The notice is deliberately blunt. The password is encrypted at rest, but it
 * has to be *reversible* - SteamCMD is handed the real password on every
 * install - so anyone holding both the database and the encryption key can
 * recover it. That is a weaker guarantee than the panel makes anywhere else,
 * and the honest advice that follows from it is to use a throwaway account.
 */

export interface SteamCredentialStatus {
  configured: boolean;
  username: string | null;
  fromEnvironment: boolean;
  setAt: string | null;
}

interface Props {
  status: SteamCredentialStatus;
  onChanged: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}

export function SteamCredentials({ status, onChanged, onError }: Props) {
  const [username, setUsername] = useState(status.username ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await api.put('/admin/steam-credentials', { username: username.trim(), password });
      // Cleared immediately: there is no reason for it to sit in a form field
      // after it has been stored.
      setPassword('');
      setSaved(true);
      await onChanged();
    } catch (caught) {
      onError(caught, 'Could not save the Steam credentials.');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setSaved(false);
    try {
      await api.delete('/admin/steam-credentials');
      setUsername('');
      setPassword('');
      await onChanged();
    } catch (caught) {
      onError(caught, 'Could not clear the Steam credentials.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold uppercase tracking-wide">Steam credentials</h2>

      {/* ---- The notice, above everything else ---- */}
      <div className="rounded-md border border-power-stop/50 bg-power-stop/10 p-3">
        <p className="text-xs font-bold uppercase tracking-wide text-power-stop">Official notice</p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-900">
          Steam login details are stored so the panel can hand them to SteamCMD on every install,
          which means they must be recoverable — they are encrypted at rest, but anyone with access
          to both this server&apos;s database and its encryption key can read them back.{' '}
          <strong>
            Please use a throwaway account to prevent loss of personal Steam accounts with games
            tied to them.
          </strong>{' '}
          Arma Server Panel does not hold any responsibility for loss or stolen Steam accounts.
        </p>
      </div>

      {/* ---- Steam Guard ---- */}
      <div className="rounded-md border border-power-restart/40 bg-power-restart/10 p-3">
        <p className="text-xs font-bold uppercase tracking-wide text-power-restart">
          Steam Guard must be off
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-900">
          SteamCMD cannot answer a Steam Guard prompt — there is nowhere for it to type a code — so
          an account with Steam Guard enabled will fail to download and the server will not install.
          Turn it off on the throwaway account, wait for Steam to apply the change, then reinstall.
          If a login is refused for this reason the server&apos;s console says so explicitly rather
          than only reporting a crash.
        </p>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {status.configured ? (
            <>
              <span className="badge bg-power-start/20 text-power-start">configured</span>
              <span className="text-ink-700">
                {status.fromEnvironment
                  ? 'Currently coming from STEAM_USERNAME in .env. Saving here replaces it.'
                  : status.setAt
                    ? `Saved ${new Date(status.setAt).toLocaleString()}`
                    : 'Saved'}
              </span>
            </>
          ) : (
            <>
              <span className="badge bg-power-stop/20 text-power-stop">not set</span>
              <span className="text-ink-700">Arma 3 servers cannot download without this.</span>
            </>
          )}
        </div>

        <div>
          <label className="label" htmlFor="steam-username">
            Steam username
          </label>
          <input
            id="steam-username"
            className="input"
            value={username}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setUsername(event.target.value);
              setSaved(false);
            }}
          />
        </div>

        <div>
          <label className="label" htmlFor="steam-password">
            Steam password
          </label>
          <input
            id="steam-password"
            type="password"
            className="input"
            value={password}
            autoComplete="new-password"
            placeholder={status.configured ? 'Unchanged — type to replace it' : ''}
            onChange={(event) => {
              setPassword(event.target.value);
              setSaved(false);
            }}
          />
          <p className="mt-1 text-xs text-ink-700">
            Never shown again once saved. To change it, type a new one.
          </p>
        </div>

        <button
          type="button"
          className="btn-start w-full"
          onClick={() => void save()}
          disabled={saving || username.trim().length === 0 || password.length === 0}
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>

        {status.configured && !status.fromEnvironment ? (
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => void clear()}
            disabled={saving}
          >
            Remove stored credentials
          </button>
        ) : null}
      </div>
    </section>
  );
}
