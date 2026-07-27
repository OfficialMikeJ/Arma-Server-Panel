'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

/**
 * Mandatory TOTP enrolment.
 *
 * Second and final gate after the forced password change. The account stays
 * PENDING_TOTP - and every feature route stays closed - until a code from the
 * authenticator verifies, which is what proves the secret was actually stored
 * somewhere the operator can reach.
 */

interface Enrollment {
  enrollmentToken: string;
  totp: { secret: string; otpauthUri: string; qrDataUrl: string };
}

export default function SetupTwoFactorPage() {
  const router = useRouter();

  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const session = await api.get<{
          authenticated: boolean;
          mustChangePassword?: boolean;
          totpVerified?: boolean;
        }>('/auth/session');

        if (!session.authenticated) {
          router.replace('/login');
          return;
        }
        // Password change comes first; the API would reject enrolment anyway.
        if (session.mustChangePassword) {
          router.replace('/panel/security/change-password');
          return;
        }
        if (session.totpVerified) {
          router.replace('/panel');
          return;
        }

        const started = await api.post<Enrollment>('/auth/totp/enroll/start');
        if (!cancelled) {
          setEnrollment(started);
          setLoading(false);
        }
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : 'Could not start enrolment.');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/totp/enroll/confirm', {
        enrollmentToken: enrollment.enrollmentToken,
        code: code.trim(),
      });
      setRecoveryCodes(result.recoveryCodes);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-500 border-t-brand-500" />
      </div>
    );
  }

  /* ---- Final step: recovery codes ---- */
  if (recoveryCodes) {
    return (
      <div className="mx-auto max-w-lg py-8">
        <div className="mb-6 text-center">
          <span className="badge bg-power-start/20 text-power-start">Done</span>
          <h1 className="mt-3 text-xl font-extrabold uppercase tracking-wide">
            Two-factor is active
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-800">
            Save these recovery codes. Each works once, and they are the only way back in if you
            lose your authenticator. <strong>They will not be shown again.</strong>
          </p>
        </div>

        <div className="card space-y-4">
          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-ink-200 p-4 font-mono text-xs">
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode} className="select-all">
                {recoveryCode}
              </li>
            ))}
          </ul>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join('\n'))}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'arma-server-panel-recovery-codes.txt';
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs text-ink-900">
            <input
              type="checkbox"
              checked={savedConfirmed}
              onChange={(event) => setSavedConfirmed(event.target.checked)}
              className="mt-0.5 accent-brand-500"
            />
            <span>I have saved these codes somewhere safe.</span>
          </label>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!savedConfirmed}
            onClick={() => {
              router.replace('/panel');
              router.refresh();
            }}
          >
            Continue to the panel
          </button>
        </div>
      </div>
    );
  }

  /* ---- Enrolment ---- */
  return (
    <div className="mx-auto max-w-lg py-8">
      <div className="mb-6 text-center">
        <span className="badge bg-power-restart/20 text-power-restart">Step 2 of 2</span>
        <h1 className="mt-3 text-xl font-extrabold uppercase tracking-wide">
          Set up two-factor authentication
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-800">
          Scan the code with any authenticator app. Standard TOTP (RFC 6238), so Aegis, Ente Auth,
          1Password, Bitwarden, Authy, Google Authenticator and Microsoft Authenticator all work.
        </p>
      </div>

      <form onSubmit={confirm} className="card space-y-4">
        {enrollment ? (
          <>
            <div className="flex justify-center rounded-lg bg-white p-4">
              {/* Data URL rendered server-side from the otpauth:// URI. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.totp.qrDataUrl}
                alt="Authenticator QR code"
                width={200}
                height={200}
              />
            </div>

            <details className="text-xs text-ink-800">
              <summary className="cursor-pointer select-none hover:text-white">
                Can&apos;t scan? Enter this key by hand
              </summary>
              <code className="mt-2 block break-all rounded bg-ink-200 p-2 font-mono text-[11px] select-all">
                {enrollment.totp.secret}
              </code>
            </details>

            <div>
              <label className="label" htmlFor="code">
                Enter the 6-digit code
              </label>
              <input
                id="code"
                className="input text-center font-mono text-xl tracking-[0.4em]"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                autoFocus
                required
              />
            </div>

            <button type="submit" className="btn-primary w-full" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify and finish'}
            </button>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
