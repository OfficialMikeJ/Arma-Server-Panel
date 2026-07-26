'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PANEL_NAME, type HostRequirementCheck } from '@asp/shared';
import { api, ApiError } from '@/lib/api';

/**
 * First-run setup wizard.
 *
 * Five gates, all enforced by the API - this screen only surfaces them:
 *   1. Host meets the hard minimum (8 GB / 4 threads / 120 GB / 50 Mbps)
 *   2. Container runtime reachable
 *   3. Default admin password changed
 *   4. TOTP enrolled
 *   5. At least one node registered
 */

interface SetupStatus {
  setupComplete: boolean;
  steps: {
    requirements: { done: boolean; checkedAt: string | null; checks: HostRequirementCheck[] };
    containerRuntime: { done: boolean; userNsRemap: boolean; message: string | null };
    adminPassword: { done: boolean };
    adminTotp: { done: boolean };
    node: { done: boolean; count: number };
  };
}

export default function SetupPage() {
  const router = useRouter();

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<HostRequirementCheck[]>([]);

  const load = useCallback(async () => {
    try {
      const result = await api.get<SetupStatus>('/setup/status');
      setStatus(result);
      if (result.steps.requirements.checks?.length) setChecks(result.steps.requirements.checks);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not read setup status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runRequirementsCheck() {
    setBusy('requirements');
    setError(null);
    try {
      const result = await api.post<{ pass: boolean; checks: HostRequirementCheck[] }>(
        '/setup/requirements/check',
        { runSpeedTest: true },
      );
      setChecks(result.checks);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The check could not be run.');
    } finally {
      setBusy(null);
    }
  }

  async function registerNode(form: FormData) {
    setBusy('node');
    setError(null);
    try {
      await api.post('/admin/nodes/local', {
        name: String(form.get('name') ?? '').trim(),
        region: String(form.get('region') ?? '').trim(),
        locationLabel: String(form.get('locationLabel') ?? '').trim(),
        publicHost: String(form.get('publicHost') ?? '').trim() || undefined,
        dataRoot: String(form.get('dataRoot') ?? '').trim() || undefined,
        portRangeStart: Number(form.get('portRangeStart') ?? 20000),
        portRangeEnd: Number(form.get('portRangeEnd') ?? 40000),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The node could not be registered.');
    } finally {
      setBusy(null);
    }
  }

  async function complete() {
    setBusy('complete');
    setError(null);
    try {
      await api.post('/setup/complete');
      router.push('/panel');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Setup could not be completed.');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ink-0">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-500 border-t-brand-500" />
      </main>
    );
  }

  if (status?.setupComplete) {
    return (
      <Shell>
        <div className="card text-center">
          <h1 className="text-lg font-bold text-power-start">Setup is already complete</h1>
          <Link href="/panel" className="btn-primary mt-6 w-full">
            Go to the panel
          </Link>
        </div>
      </Shell>
    );
  }

  const steps = status?.steps;
  const allDone =
    steps &&
    steps.requirements.done &&
    steps.containerRuntime.done &&
    steps.adminPassword.done &&
    steps.adminTotp.done &&
    steps.node.done;

  return (
    <Shell>
      <div className="space-y-4">
        {/* ---- 1. Host requirements ---- */}
        <Step
          number={1}
          title="Host requirements"
          done={steps?.requirements.done ?? false}
          description="Hard minimum: 8 GB RAM, 4 cores/threads, 120 GB storage, 50 Mbps up and down."
        >
          {checks.length > 0 ? (
            <ul className="mb-3 space-y-1.5">
              {checks.map((check) => (
                <li key={check.key} className="flex items-center justify-between gap-3 text-xs">
                  <span className={check.pass ? 'text-power-start' : 'text-power-stop'}>
                    {check.pass ? '✓' : '✕'} {check.label}
                  </span>
                  <span className="font-mono text-ink-800">
                    {check.detected} <span className="text-ink-600">/ {check.required}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => void runRequirementsCheck()}
            disabled={busy !== null}
          >
            {busy === 'requirements' ? 'Measuring… (this runs a speed test)' : 'Run the check'}
          </button>
        </Step>

        {/* ---- 2. Container runtime ---- */}
        <Step
          number={2}
          title="Container runtime"
          done={steps?.containerRuntime.done ?? false}
          description="Docker must be reachable for game servers to be created."
        >
          {steps?.containerRuntime.done ? (
            <p className="text-xs text-ink-800">
              Connected.
              {steps.containerRuntime.userNsRemap ? (
                <span className="text-power-start"> User-namespace remapping is on.</span>
              ) : (
                <span className="text-power-restart">
                  {' '}
                  User-namespace remapping is off. Enable{' '}
                  <code className="font-mono">--userns-remap=default</code> on the Docker daemon so a
                  container escape does not land on host root.
                </span>
              )}
            </p>
          ) : (
            <p className="text-xs text-power-stop">
              {steps?.containerRuntime.message ?? 'Not reachable.'}
            </p>
          )}
        </Step>

        {/* ---- 3 & 4. Account security ---- */}
        <Step
          number={3}
          title="Administrator password"
          done={steps?.adminPassword.done ?? false}
          description="The shipped default must be replaced."
        >
          {!steps?.adminPassword.done ? (
            <Link href="/panel/security/change-password" className="btn-primary w-full">
              Change it now
            </Link>
          ) : (
            <p className="text-xs text-power-start">Changed. The default no longer works.</p>
          )}
        </Step>

        <Step
          number={4}
          title="Two-factor authentication"
          done={steps?.adminTotp.done ?? false}
          description="Required on the administrator account."
        >
          {!steps?.adminTotp.done ? (
            <Link href="/panel/security/setup-2fa" className="btn-primary w-full">
              Set it up
            </Link>
          ) : (
            <p className="text-xs text-power-start">Enrolled.</p>
          )}
        </Step>

        {/* ---- 5. Node ---- */}
        <Step
          number={5}
          title="Register this machine as a node"
          done={steps?.node.done ?? false}
          description="Capacity is detected from the hardware, not taken from this form — it cannot be overstated."
        >
          {steps?.node.done ? (
            <p className="text-xs text-power-start">
              {steps.node.count} node{steps.node.count === 1 ? '' : 's'} registered.
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void registerNode(new FormData(event.currentTarget));
              }}
              className="space-y-3"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="name">
                    Node name
                  </label>
                  <input id="name" name="name" className="input" defaultValue="local" required />
                </div>
                <div>
                  <label className="label" htmlFor="region">
                    Region
                  </label>
                  <input id="region" name="region" className="input" defaultValue="home" required />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="locationLabel">
                  Location label (shown publicly)
                </label>
                <input
                  id="locationLabel"
                  name="locationLabel"
                  className="input"
                  defaultValue="Home Server"
                  required
                />
              </div>

              <div>
                <label className="label" htmlFor="publicHost">
                  Public address players connect to
                </label>
                <input
                  id="publicHost"
                  name="publicHost"
                  className="input"
                  placeholder="leave blank to auto-detect"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="portRangeStart">
                    Port range start
                  </label>
                  <input
                    id="portRangeStart"
                    name="portRangeStart"
                    type="number"
                    className="input"
                    defaultValue={20000}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="portRangeEnd">
                    Port range end
                  </label>
                  <input
                    id="portRangeEnd"
                    name="portRangeEnd"
                    type="number"
                    className="input"
                    defaultValue={40000}
                  />
                </div>
              </div>

              <button type="submit" className="btn-primary w-full" disabled={busy !== null}>
                {busy === 'node' ? 'Registering…' : 'Register node'}
              </button>
            </form>
          )}
        </Step>

        {/* ---- Finish ---- */}
        <div className="card">
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void complete()}
            disabled={!allDone || busy !== null}
          >
            {busy === 'complete' ? 'Finishing…' : 'Complete setup'}
          </button>
          {!allDone ? (
            <p className="mt-2 text-center text-xs text-ink-700">
              All five steps must pass first.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
            {error}
          </p>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="min-h-screen bg-ink-0 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-brand-500 text-lg font-black text-white">
            A
          </span>
          <h1 className="mt-3 text-xl font-extrabold uppercase tracking-wide">{PANEL_NAME}</h1>
          <p className="text-sm text-ink-800">First-run setup</p>
        </div>
        {children}
      </div>
    </main>
  );
}

function Step({
  number,
  title,
  description,
  done,
  children,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`card ${done ? 'border-power-start/40' : ''}`}>
      <div className="mb-3 flex items-start gap-3">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            done ? 'bg-power-start text-ink-0' : 'bg-ink-400 text-ink-900'
          }`}
          aria-hidden
        >
          {done ? '✓' : number}
        </span>
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-700">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
