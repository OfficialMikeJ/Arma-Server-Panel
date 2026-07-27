'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { NodeAdmin, type NodeRow } from '@/components/panel/admin/NodeAdmin';
import { SubAdminAdmin, type PanelAccountRow } from '@/components/panel/admin/SubAdminAdmin';
import { AccessRequests, type AccessRequestRow } from '@/components/panel/admin/AccessRequests';

/**
 * Platform administration: nodes, panel accounts, access requests and the
 * audit trail.
 *
 * Each section is rendered only when the viewer holds the permission behind it,
 * so a sub-admin sees exactly what they can act on rather than a page of
 * buttons that return 403.
 *
 * Every route behind this needs an *elevated* session, which expires after
 * 20 minutes idle. A 403 with `step_up_required` means re-proving TOTP.
 */

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: { type: string; id: string | null } | null;
  outcome: string;
}

export default function AdminPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [accounts, setAccounts] = useState<PanelAccountRow[]>([]);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [me, setMe] = useState<{ id: string; panelPermissions: string[] } | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [code, setCode] = useState('');
  const [chain, setChain] = useState<{ valid: boolean; checked: number; brokenAtId: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      // Who the viewer is decides which sections exist, so it is fetched first
      // and on its own - a failure here means the page cannot be drawn at all.
      const identity = await api.get<{
        account: { id: string; panelPermissions: string[] };
      }>('/account');
      setMe(identity.account);

      // Each section is optional. A sub-admin holding only panel:nodes.read
      // gets the node list and no 403s for the three sections they cannot see,
      // so one missing permission does not blank the page.
      const [nodeResult, auditResult, accountResult, requestResult] = await Promise.all([
        api.get<{ nodes: NodeRow[] }>('/admin/nodes').catch(skipForbidden),
        api.get<{ entries: AuditRow[] }>('/admin/audit?limit=50').catch(skipForbidden),
        api.get<{ accounts: PanelAccountRow[] }>('/admin/panel-accounts').catch(skipForbidden),
        api.get<{ requests: AccessRequestRow[] }>('/admin/access-requests').catch(skipForbidden),
      ]);

      setNodes(nodeResult?.nodes ?? []);
      setAudit(auditResult?.entries ?? []);
      setAccounts(accountResult?.accounts ?? []);
      setRequests(requestResult?.requests ?? []);
      setStepUpNeeded(false);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setStepUpNeeded(true);
        setError(null);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not load administration.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Whether the viewer holds a panel permission.
   *
   * The API is the authority; this only decides what to draw. A sub-admin who
   * lacks a permission is not shown its section rather than shown a section
   * that answers 403 on every action.
   */
  const can = (permission: string) => (me?.panelPermissions ?? []).includes(permission);

  function report(caught: unknown, fallback: string) {
    if (caught instanceof ApiError && caught.code === 'step_up_required') {
      setStepUpNeeded(true);
      return;
    }
    setError(caught instanceof ApiError ? caught.message : fallback);
  }

  async function stepUp(event: React.FormEvent) {
    event.preventDefault();
    setBusy('stepup');
    setError(null);
    try {
      await api.post('/auth/admin/step-up', { code: code.trim() });
      setCode('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code is not correct.');
    } finally {
      setBusy(null);
    }
  }

  async function verifyChain() {
    setBusy('chain');
    setError(null);
    try {
      setChain(await api.post('/admin/audit/verify'));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Verification failed.');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="card h-48 animate-pulse bg-ink-200" />;

  if (stepUpNeeded) {
    return (
      <div className="mx-auto max-w-md">
        <form onSubmit={stepUp} className="card space-y-4">
          <div>
            <h1 className="text-lg font-bold">Re-authenticate</h1>
            <p className="mt-1 text-sm leading-relaxed text-ink-800">
              Administrative actions need an elevated session, which expires after 20 minutes of
              inactivity. Enter a code from your authenticator.
            </p>
          </div>
          <input
            className="input text-center font-mono text-xl tracking-[0.4em]"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            autoFocus
            required
          />
          <button type="submit" className="btn-primary w-full" disabled={busy !== null || code.length !== 6}>
            {busy === 'stepup' ? 'Verifying…' : 'Elevate session'}
          </button>
          {error ? (
            <p role="alert" className="text-sm text-power-stop">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-extrabold uppercase tracking-wide">Administration</h1>

      {can('panel:requests.review') ? (
        <AccessRequests requests={requests} onChanged={load} onError={report} />
      ) : null}

      {can('panel:nodes.read') ? (
        <NodeAdmin
          nodes={nodes}
          canWrite={can('panel:nodes.write')}
          onChanged={load}
          onError={report}
        />
      ) : null}

      {can('panel:accounts.read') ? (
        <SubAdminAdmin
          accounts={accounts}
          grantable={me?.panelPermissions ?? []}
          canWrite={can('panel:accounts.write')}
          currentAccountId={me?.id ?? null}
          onChanged={load}
          onError={report}
        />
      ) : null}

      {/* ---- Audit ---- */}
      <section className={`card ${can('panel:audit.read') ? '' : 'hidden'}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide">Audit trail</h2>
          <button
            type="button"
            className="btn-ghost h-8 px-3 text-[11px]"
            onClick={() => void verifyChain()}
            disabled={busy !== null}
          >
            {busy === 'chain' ? 'Verifying…' : 'Verify integrity'}
          </button>
        </div>

        {chain ? (
          <p
            className={`mb-3 rounded-md p-3 text-xs ${
              chain.valid
                ? 'bg-power-start/10 text-power-start'
                : 'bg-power-stop/10 text-power-stop'
            }`}
          >
            {chain.valid
              ? `Hash chain intact across ${chain.checked} entries — no tampering detected.`
              : `Chain broken at entry ${chain.brokenAtId}. Entries after this point cannot be trusted.`}
          </p>
        ) : null}

        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-ink-100 text-ink-700">
              <tr>
                <th scope="col" className="pb-2 pr-3 font-semibold">When</th>
                <th scope="col" className="pb-2 pr-3 font-semibold">Actor</th>
                <th scope="col" className="pb-2 pr-3 font-semibold">Action</th>
                <th scope="col" className="pb-2 font-semibold">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-300">
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-700">
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3 truncate">{entry.actor}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px]">{entry.action}</td>
                  <td
                    className={`py-1.5 ${
                      entry.outcome === 'success'
                        ? 'text-ink-800'
                        : entry.outcome === 'denied'
                          ? 'text-power-restart'
                          : 'text-power-stop'
                    }`}
                  >
                    {entry.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}


/**
 * Swallows a 403 so one missing permission does not blank the whole page.
 *
 * Anything else still propagates: a network failure or a step-up requirement
 * is a real problem the operator needs to see.
 */
function skipForbidden(caught: unknown): null {
  if (caught instanceof ApiError && caught.status === 403 && caught.code !== 'step_up_required') {
    return null;
  }
  throw caught;
}
