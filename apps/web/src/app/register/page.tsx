'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PANEL_NAME, USERNAME_POLICY } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * Registration.
 *
 * Three steps: choose a username, enrol an authenticator, save recovery codes.
 * There is no password at any point.
 *
 * The username field checks as you type, and surfaces the warn-then-ban policy
 * honestly: a rejected name produces a warning that says, in plain words, that
 * submitting it again blocks registration for two hours.
 */

type Step = 'username' | 'totp' | 'recovery';

interface UsernameStatus {
  available: boolean;
  status: 'accepted' | 'rejected' | 'warned' | 'banned' | 'rate_limited' | 'already_banned';
  message: string;
  isFinalWarning: boolean;
}

interface EnrollmentResponse {
  enrollmentToken: string;
  totp: { secret: string; otpauthUri: string; qrDataUrl: string };
}

export default function RegisterPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>('username');
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState<UsernameStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banned, setBanned] = useState<{ until: number } | null>(null);
  const [discordToken, setDiscordToken] = useState<string | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Is registration even open? ---- */
  useEffect(() => {
    api
      .get<{ registrationOpen: boolean; registrationMessage: string | null }>('/public/status')
      .then((result) => {
        setRegistrationOpen(result.registrationOpen);
        setClosedReason(result.registrationMessage);
      })
      .catch(() => setRegistrationOpen(true));
  }, []);

  /* ---- A Discord flow may have handed us a link token ---- */
  useEffect(() => {
    const stored = sessionStorage.getItem('asp_discord_link');
    if (stored) {
      setDiscordToken(stored);
      const suggestion = sessionStorage.getItem('asp_discord_username');
      if (suggestion) setUsername(suggestion);
    }
  }, []);

  const checkUsername = useCallback(async (value: string) => {
    if (value.length < USERNAME_POLICY.minLength) {
      setStatus(null);
      return;
    }
    setChecking(true);
    try {
      const result = await api.post<UsernameStatus>('/auth/username/check', { username: value });
      setStatus(result);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'registration_banned') {
        setBanned({ until: Date.now() + (caught.retryAfterSeconds ?? 7200) * 1000 });
        setStatus(null);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!username) {
      setStatus(null);
      return;
    }
    debounceRef.current = setTimeout(() => void checkUsername(username), 450);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [username, checkUsername]);

  async function startRegistration(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<EnrollmentResponse>('/auth/register/start', {
        username,
        acceptedTerms: true,
        ...(discordToken ? { discordLinkToken: discordToken } : {}),
      });
      setEnrollment(result);
      setStep('totp');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        if (caught.code === 'registration_banned') {
          setBanned({ until: Date.now() + (caught.retryAfterSeconds ?? 7200) * 1000 });
        }
      } else {
        setError('Could not start registration.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function completeRegistration(event: React.FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/register/complete', {
        enrollmentToken: enrollment.enrollmentToken,
        code: code.trim(),
      });
      setRecoveryCodes(result.recoveryCodes);
      sessionStorage.removeItem('asp_discord_link');
      sessionStorage.removeItem('asp_discord_username');
      setStep('recovery');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (registrationOpen === false) {
    return (
      <Shell>
        <div className="card text-center">
          <h1 className="text-lg font-bold">Registration is closed</h1>
          <p className="mt-2 text-sm text-ink-800">
            {closedReason ?? 'This panel is not accepting new accounts right now.'}
          </p>
          <Link href="/" className="btn-secondary mt-6 w-full">
            Back to home
          </Link>
        </div>
      </Shell>
    );
  }

  if (banned) {
    const minutes = Math.max(1, Math.ceil((banned.until - Date.now()) / 60000));
    return (
      <Shell>
        <div className="card border-power-stop/40 text-center">
          <h1 className="text-lg font-bold text-power-stop">Registration blocked</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-900">
            You were warned that the username you chose was not acceptable, and it was submitted
            again. Registration from this connection is blocked for{' '}
            <strong>{minutes} more minutes</strong>.
          </p>
          <Link href="/" className="btn-secondary mt-6 w-full">
            Back to home
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Steps current={step} />

      {/* ================= Step 1: username ================= */}
      {step === 'username' ? (
        <form onSubmit={startRegistration} className="card space-y-4">
          <div>
            <h1 className="text-lg font-bold">Choose a username</h1>
            <p className="mt-1 text-sm text-ink-800">
              {USERNAME_POLICY.minLength}–{USERNAME_POLICY.maxLength} characters. Letters, numbers,
              underscore and hyphen.
            </p>
          </div>

          {discordToken ? (
            <p className="rounded-md bg-brand-500/10 p-3 text-xs text-brand-300">
              Your Discord account will be linked once registration completes.
            </p>
          ) : null}

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
              minLength={USERNAME_POLICY.minLength}
              maxLength={USERNAME_POLICY.maxLength}
              required
            />

            {checking ? <p className="mt-1.5 text-xs text-ink-700">Checking…</p> : null}

            {status && !checking ? (
              <p
                className={`mt-1.5 text-xs leading-relaxed ${
                  status.available
                    ? 'text-power-start'
                    : status.status === 'warned'
                      ? 'text-power-restart'
                      : 'text-power-stop'
                }`}
              >
                {status.isFinalWarning ? <strong>Warning: </strong> : null}
                {status.message}
              </p>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-900">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              className="mt-0.5 accent-brand-500"
              required
            />
            <span>
              I agree to the{' '}
              <Link href="/legal/terms-of-service" className="text-brand-500 hover:underline">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/legal/privacy" className="text-brand-500 hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={busy || !accepted || !status?.available}
          >
            {busy ? 'Please wait…' : 'Continue'}
          </button>
        </form>
      ) : null}

      {/* ================= Step 2: authenticator ================= */}
      {step === 'totp' && enrollment ? (
        <form onSubmit={completeRegistration} className="card space-y-4">
          <div>
            <h1 className="text-lg font-bold">Set up your authenticator</h1>
            <p className="mt-1 text-sm text-ink-800">
              Scan this with any authenticator app — we recommend Google Authenticator. This
              replaces a password entirely.
            </p>
          </div>

          <div className="flex justify-center rounded-lg bg-white p-4">
            {/* Data URL generated server-side from the otpauth:// URI. */}
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
              Can&apos;t scan? Enter the key manually
            </summary>
            <code className="mt-2 block break-all rounded bg-ink-200 p-2 font-mono text-[11px]">
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
            {busy ? 'Verifying…' : 'Verify and create account'}
          </button>
        </form>
      ) : null}

      {/* ================= Step 3: recovery codes ================= */}
      {step === 'recovery' ? (
        <div className="card space-y-4">
          <div>
            <h1 className="text-lg font-bold text-power-start">Account created</h1>
            <p className="mt-1 text-sm leading-relaxed text-ink-800">
              Save these recovery codes somewhere safe. Each one works once, and they are the only
              way back in if you lose your authenticator. <strong>They will not be shown again.</strong>
            </p>
          </div>

          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-ink-200 p-4 font-mono text-xs">
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode} className="select-all">
                {recoveryCode}
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => {
              void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
            }}
          >
            Copy all codes
          </button>

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
              router.push('/panel');
              router.refresh();
            }}
          >
            Go to the panel
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}

      <p className="mt-6 text-center text-sm text-ink-700">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-brand-500 hover:underline">
          Sign in
        </Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-ink-0 px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-500 font-black text-white">
            A
          </span>
          <span className="text-lg font-bold">{PANEL_NAME}</span>
        </Link>
        {children}
      </div>
    </main>
  );
}

function Steps({ current }: { current: Step }) {
  const order: Step[] = ['username', 'totp', 'recovery'];
  const index = order.indexOf(current);

  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Registration progress">
      {['Username', 'Authenticator', 'Recovery codes'].map((label, position) => (
        <li key={label} className="flex flex-1 flex-col gap-1.5">
          <div
            className={`h-1 rounded-full ${position <= index ? 'bg-brand-500' : 'bg-ink-400'}`}
            aria-hidden
          />
          <span
            className={`text-[10px] font-bold uppercase tracking-wide ${
              position <= index ? 'text-brand-500' : 'text-ink-700'
            }`}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
