'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PANEL_NAME } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Sign in.
 *
 * Two paths, both ending in TOTP:
 *   * Users: username -> authenticator code. No password exists.
 *   * Administrators: username + password -> authenticator code.
 *
 * Error copy is deliberately uniform ("that code is not correct") so the form
 * cannot be used to work out which usernames exist.
 */

type Step = 'identify' | 'totp' | 'admin-password';
type Mode = 'user' | 'admin';

export default function LoginPage() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('user');
  const [step, setStep] = useState<Step>('identify');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/auth/discord/status')
      .then((result) => setDiscordEnabled(result.enabled))
      .catch(() => setDiscordEnabled(false));
  }, []);

  async function startUserLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        outcome?: 'authenticated' | 'totp_required';
        challengeToken?: string;
        message: string;
      }>('/auth/login/start', { username });

      // This browser was remembered, so the authenticator step is skipped.
      if (result.outcome === 'authenticated') {
        router.push('/panel');
        router.refresh();
        return;
      }

      setChallengeToken(result.challengeToken ?? '');
      setNotice(result.message);
      setStep('totp');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start sign-in.');
    } finally {
      setBusy(false);
    }
  }

  async function startAdminLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        outcome: 'totp_required' | 'password_change_required' | 'totp_enrollment_required';
        challengeToken?: string;
        message?: string;
      }>('/auth/admin/login', { username, password });

      if (result.outcome === 'password_change_required') {
        router.push('/panel/security/change-password');
        return;
      }
      if (result.outcome === 'totp_enrollment_required') {
        router.push('/panel/security/setup-2fa');
        return;
      }

      setChallengeToken(result.challengeToken ?? '');
      setNotice(result.message ?? null);
      setStep('totp');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login/verify', {
        challengeToken,
        code: code.trim(),
        rememberDevice,
      });
      router.push('/panel');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function startDiscord() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ url: string }>('/auth/discord/start', {
        intent: 'login',
        returnTo: '/panel',
      });
      window.location.href = result.url;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Discord sign-in is unavailable.');
      setBusy(false);
    }
  }

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-ink-0 px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-500 font-black text-white">
            A
          </span>
          <span className="text-lg font-bold">{PANEL_NAME}</span>
        </Link>

        <div className="card">
          {step === 'identify' ? (
            <>
              <div className="mb-6 flex rounded-lg border border-ink-400 p-1">
                {(['user', 'admin'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setMode(option);
                      setError(null);
                    }}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                      mode === option ? 'bg-brand-500 text-white' : 'text-ink-800 hover:text-white'
                    }`}
                  >
                    {option === 'user' ? 'Member' : 'Administrator'}
                  </button>
                ))}
              </div>

              <form onSubmit={mode === 'user' ? startUserLogin : startAdminLogin} className="space-y-4">
                <div>
                  <label className="label" htmlFor="username">
                    Username
                  </label>
                  <input
                    id="username"
                    className="input"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                    minLength={1}
                    maxLength={64}
                  />
                </div>

                {mode === 'admin' ? (
                  <div>
                    <label className="label" htmlFor="password">
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      className="input"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed text-ink-700">
                    Member accounts have no password. You will be asked for the 6-digit code from
                    your authenticator app.
                  </p>
                )}

                <button type="submit" className="btn-primary w-full" disabled={busy || !username}>
                  {busy ? 'Please wait…' : 'Continue'}
                </button>
              </form>

              {discordEnabled && mode === 'user' ? (
                <>
                  <div className="my-5 flex items-center gap-3 text-[11px] uppercase text-ink-700">
                    <span className="h-px flex-1 bg-ink-400" />
                    or
                    <span className="h-px flex-1 bg-ink-400" />
                  </div>
                  <button
                    type="button"
                    onClick={() => void startDiscord()}
                    disabled={busy}
                    className="btn-secondary w-full"
                  >
                    Continue with Discord
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <div>
                <h1 className="text-lg font-bold">Two-factor code</h1>
                <p className="mt-1 text-sm text-ink-800">
                  {notice ?? 'Enter the 6-digit code from your authenticator app.'}
                </p>
              </div>

              <div>
                <label className="label" htmlFor="code">
                  {useRecoveryCode ? 'Recovery code' : '6-digit code'}
                </label>

                {useRecoveryCode ? (
                  <input
                    id="code"
                    className="input text-center font-mono text-lg tracking-[0.2em]"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    inputMode="text"
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    autoFocus
                    maxLength={19}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    required
                  />
                ) : (
                  <input
                    id="code"
                    className="input text-center font-mono text-xl tracking-[0.4em]"
                    value={code}
                    // Digits only: a TOTP code is exactly six of them, and
                    // stripping anything else stops a stray paste blocking it.
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={6}
                    placeholder="000000"
                    required
                  />
                )}

                <button
                  type="button"
                  onClick={() => {
                    setUseRecoveryCode((value) => !value);
                    setCode('');
                    setError(null);
                  }}
                  className="mt-2 text-xs text-brand-500 hover:underline"
                >
                  {useRecoveryCode
                    ? 'Use my authenticator instead'
                    : 'Lost your authenticator? Use a recovery code'}
                </button>
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-900">
                <input
                  type="checkbox"
                  checked={rememberDevice}
                  onChange={(event) => setRememberDevice(event.target.checked)}
                  className="mt-0.5 accent-brand-500"
                />
                <span>
                  Remember this browser for 14 days — you&apos;ll only need your username to sign in.
                  Uncheck on a shared computer.
                </span>
              </label>

              <button
                type="submit"
                className="btn-primary w-full"
                disabled={busy || (useRecoveryCode ? code.length < 16 : code.length !== 6)}
              >
                {busy ? 'Verifying…' : 'Sign in'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep('identify');
                  setCode('');
                  setError(null);
                }}
                className="btn-ghost w-full"
              >
                Back
              </button>
            </form>
          )}

          {error ? (
            <p role="alert" className="mt-4 rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
              {error}
            </p>
          ) : null}
        </div>

        <p className="mt-6 text-center text-sm text-ink-700">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="font-semibold text-brand-500 hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
