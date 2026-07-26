'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PANEL_NAME } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Forced password change.
 *
 * Reached automatically after signing in with the first-run credential. The
 * API refuses every other route until this completes, so there is deliberately
 * no way to navigate away except by finishing or signing out.
 */

const RULES = [
  { label: 'At least 14 characters', test: (v: string) => v.length >= 14 },
  { label: 'A lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { label: 'An uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'A digit', test: (v: string) => /\d/.test(v) },
  { label: 'A symbol', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
  {
    label: 'No character repeated 4+ times',
    test: (v: string) => v.length > 0 && !/(.)\1{3,}/.test(v),
  },
  {
    label: 'Not a well-known weak phrase',
    test: (v: string) =>
      v.length > 0 &&
      !['password123', 'admin', 'administrator', 'letmein', 'changeme'].some((bad) =>
        v.toLowerCase().includes(bad),
      ),
  },
];

export default function ChangePasswordPage() {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // If the account no longer needs this, do not leave the user stranded here.
  useEffect(() => {
    api
      .get<{ authenticated: boolean; mustChangePassword?: boolean; totpVerified?: boolean }>(
        '/auth/session',
      )
      .then((session) => {
        if (!session.authenticated) {
          router.replace('/login');
          return;
        }
        if (!session.mustChangePassword) {
          router.replace(session.totpVerified ? '/panel' : '/panel/security/setup-2fa');
          return;
        }
        setChecking(false);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  const rulesPassed = RULES.every((rule) => rule.test(newPassword));
  const matches = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit = currentPassword.length > 0 && rulesPassed && matches && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ nextStep: string }>('/auth/admin/change-password', {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      router.replace(result.nextStep === 'complete' ? '/panel' : '/panel/security/setup-2fa');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the password.');
      setBusy(false);
    }
  }

  async function signOut() {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  }

  if (checking) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-500 border-t-brand-500" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-8">
      <div className="mb-6 text-center">
        <span className="badge bg-power-restart/20 text-power-restart">Step 1 of 2</span>
        <h1 className="mt-3 text-xl font-extrabold uppercase tracking-wide">Change your password</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-800">
          This account is still using the password {PANEL_NAME} shipped with. Choose a new one to
          continue — the default stops working the moment you do, permanently.
        </p>
      </div>

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label" htmlFor="current">
            Current password
          </label>
          <input
            id="current"
            type={reveal ? 'text' : 'password'}
            className="input"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="new">
            New password
          </label>
          <input
            id="new"
            type={reveal ? 'text' : 'password'}
            className="input"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="confirm">
            Confirm new password
          </label>
          <input
            id="confirm"
            type={reveal ? 'text' : 'password'}
            className="input"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
          {confirmPassword.length > 0 && !matches ? (
            <p className="mt-1.5 text-xs text-power-stop">Passwords do not match.</p>
          ) : null}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-800">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(event) => setReveal(event.target.checked)}
            className="accent-brand-500"
          />
          Show passwords
        </label>

        <ul className="space-y-1 rounded-lg bg-ink-200 p-3">
          {RULES.map((rule) => {
            const passed = rule.test(newPassword);
            return (
              <li
                key={rule.label}
                className={`flex items-center gap-2 text-xs ${
                  newPassword.length === 0
                    ? 'text-ink-700'
                    : passed
                      ? 'text-power-start'
                      : 'text-ink-800'
                }`}
              >
                <span aria-hidden className="w-3">
                  {newPassword.length > 0 && passed ? '✓' : '·'}
                </span>
                {rule.label}
              </li>
            );
          })}
        </ul>

        <button type="submit" className="btn-primary w-full" disabled={!canSubmit}>
          {busy ? 'Saving…' : 'Change password'}
        </button>

        {error ? (
          <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
            {error}
          </p>
        ) : null}
      </form>

      <button type="button" onClick={() => void signOut()} className="btn-ghost mt-4 w-full">
        Sign out
      </button>
    </div>
  );
}
