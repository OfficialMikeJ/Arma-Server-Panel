'use client';

import { useState } from 'react';
import { PANEL_PERMISSION_LABELS, type PanelPermission } from '@asp/shared';
import { api } from '@/lib/api';

/**
 * The access request inbox.
 *
 * Sub-users and sub-admins cannot widen their own access, so they ask here and
 * an administrator decides. Approving is the only action that grants anything,
 * and it goes through the same "you cannot hand on what you do not hold" check
 * as editing permissions directly.
 */

export interface AccessRequestRow {
  id: string;
  scope: 'panel' | 'server';
  serverName: string | null;
  requester: string | null;
  requesterType: string | null;
  requested: string[];
  reason: string;
  status: string;
  createdAt: string;
}

interface Props {
  requests: AccessRequestRow[];
  onChanged: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}

export function AccessRequests({ requests, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [granting, setGranting] = useState<Record<string, string[]>>({});

  async function decide(request: AccessRequestRow, approve: boolean) {
    setBusy(request.id);
    try {
      await api.post(`/admin/access-requests/${request.id}`, {
        approve,
        note: note[request.id]?.trim() || undefined,
        // Only sent when the reviewer has narrowed it; otherwise the server
        // grants exactly what was asked for.
        ...(approve && granting[request.id] ? { grant: granting[request.id] } : {}),
      });
      await onChanged();
    } catch (caught) {
      onError(caught, 'Could not record that decision.');
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Access requests</h2>
        <div className="card text-center text-sm text-ink-800">Nothing waiting.</div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Access requests</h2>
        <span className="badge bg-power-restart/20 text-power-restart">{requests.length} waiting</span>
      </div>

      {requests.map((request) => {
        const selected = granting[request.id] ?? request.requested;

        return (
          <div key={request.id} className="card space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="font-bold">{request.requester ?? 'unknown'}</span>
                <span className="ml-2 text-xs text-ink-700">
                  {request.scope === 'server'
                    ? `on ${request.serverName ?? 'a server'}`
                    : 'panel access'}
                </span>
              </div>
              <span className="text-xs text-ink-700">
                {new Date(request.createdAt).toLocaleString()}
              </span>
            </div>

            <blockquote className="border-l-2 border-ink-300 pl-3 text-sm leading-relaxed text-ink-900">
              {request.reason}
            </blockquote>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-700">
                Asked for — untick anything you do not want to grant
              </p>
              {request.requested.map((permission) => (
                <label key={permission} className="flex cursor-pointer items-start gap-2 text-sm text-ink-900">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-brand-500"
                    checked={selected.includes(permission)}
                    onChange={(event) =>
                      setGranting((current) => ({
                        ...current,
                        [request.id]: event.target.checked
                          ? [...new Set([...selected, permission])]
                          : selected.filter((p) => p !== permission),
                      }))
                    }
                  />
                  <span>
                    {PANEL_PERMISSION_LABELS[permission as PanelPermission] ?? permission}
                    <span className="ml-1.5 font-mono text-xs text-ink-700">{permission}</span>
                  </span>
                </label>
              ))}
            </div>

            <div>
              <label className="label" htmlFor={`note-${request.id}`}>
                Note back to them (optional)
              </label>
              <input
                id={`note-${request.id}`}
                className="input"
                value={note[request.id] ?? ''}
                onChange={(event) =>
                  setNote((current) => ({ ...current, [request.id]: event.target.value }))
                }
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn-start flex-1"
                onClick={() => void decide(request, true)}
                disabled={busy !== null || selected.length === 0}
              >
                {busy === request.id ? 'Saving…' : `Approve ${selected.length} of ${request.requested.length}`}
              </button>
              <button
                type="button"
                className="btn-stop flex-1"
                onClick={() => void decide(request, false)}
                disabled={busy !== null}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
