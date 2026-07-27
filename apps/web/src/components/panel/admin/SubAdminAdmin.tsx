'use client';

import { useState } from 'react';
import {
  PANEL_PERMISSIONS,
  PANEL_PERMISSION_LABELS,
  PANEL_PERMISSIONS_GRANTING_ACCESS,
  type PanelPermission,
} from '@asp/shared';
import { api } from '@/lib/api';

/**
 * Sub-admin accounts.
 *
 * A sub-admin administers the panel and nothing else. Where a full ADMIN gets
 * implicit admin on every server, a sub-admin gets exactly the boxes ticked
 * here and no server access at all - to touch a game server they have to be
 * added to it as a member like anybody else.
 */

export interface PanelAccountRow {
  id: string;
  username: string;
  type: 'ADMIN' | 'SUB_ADMIN';
  status: string;
  isPlatformOwner: boolean;
  panelPermissions: string[];
  effectivePermissions: string[];
  lastLoginAt: string | null;
}

interface Props {
  accounts: PanelAccountRow[];
  /** What the viewer holds. Nothing beyond this can be granted. */
  grantable: string[];
  canWrite: boolean;
  currentAccountId: string | null;
  onChanged: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}

export function SubAdminAdmin({
  accounts,
  grantable,
  canWrite,
  currentAccountId,
  onChanged,
  onError,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Panel accounts</h2>
        {canWrite ? (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add sub-admin'}
          </button>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-ink-700">
        Sub-admins administer the panel only. They are never given access to a game server by being
        one — if a sub-admin needs to work on a server, add them to it as a member.
      </p>

      {created ? (
        <div className="card space-y-2 border-brand-500/50">
          <h3 className="text-sm font-bold">One-time password for {created.username}</h3>
          <p className="text-xs leading-relaxed text-ink-700">
            Shown once and never again. They must change it and enrol two-factor authentication
            before the account can do anything.
          </p>
          <code className="block break-all rounded bg-ink-200 p-3 font-mono text-sm">
            {created.password}
          </code>
          <button type="button" className="btn-secondary w-full" onClick={() => setCreated(null)}>
            I have copied it
          </button>
        </div>
      ) : null}

      {adding ? (
        <CreateSubAdmin
          grantable={grantable}
          onCreated={async (result) => {
            setCreated(result);
            setAdding(false);
            await onChanged();
          }}
          onError={onError}
        />
      ) : null}

      {accounts.map((account) => (
        <div key={account.id} className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-bold">{account.username}</span>
              <span className="ml-2 text-xs text-ink-700">
                {account.lastLoginAt
                  ? `last seen ${new Date(account.lastLoginAt).toLocaleDateString()}`
                  : 'never signed in'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="badge bg-ink-300 text-ink-900">
                {account.isPlatformOwner ? 'OWNER' : account.type === 'ADMIN' ? 'ADMIN' : 'SUB-ADMIN'}
              </span>
              {account.status !== 'ACTIVE' ? (
                <span className="badge bg-power-restart/20 text-power-restart">{account.status}</span>
              ) : null}
            </div>
          </div>

          {account.type === 'ADMIN' || account.isPlatformOwner ? (
            <p className="text-xs text-ink-700">
              Full administrator: every panel permission, and admin on every server.
            </p>
          ) : editing === account.id ? (
            <EditSubAdmin
              account={account}
              grantable={grantable}
              onDone={async () => {
                setEditing(null);
                await onChanged();
              }}
              onCancel={() => setEditing(null)}
              onError={onError}
            />
          ) : (
            <>
              <PermissionSummary permissions={account.effectivePermissions} />
              {canWrite && account.id !== currentAccountId ? (
                <button
                  type="button"
                  className="btn-secondary w-full"
                  onClick={() => setEditing(account.id)}
                >
                  Edit permissions
                </button>
              ) : account.id === currentAccountId ? (
                <p className="text-xs text-ink-700">
                  This is you. Nobody edits their own permissions — ask another administrator.
                </p>
              ) : null}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function PermissionSummary({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <p className="text-xs text-ink-700">No panel permissions. This account can do nothing yet.</p>;
  }
  return (
    <ul className="space-y-0.5 text-xs text-ink-800">
      {permissions.map((permission) => (
        <li key={permission}>
          · {PANEL_PERMISSION_LABELS[permission as PanelPermission] ?? permission}
        </li>
      ))}
    </ul>
  );
}

function PermissionPicker({
  selected,
  grantable,
  onToggle,
  onAll,
  onNone,
}: {
  selected: string[];
  grantable: string[];
  onToggle: (permission: PanelPermission, on: boolean) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button type="button" className="btn-ghost h-7 px-2 text-[11px]" onClick={onAll}>
          Full access
        </button>
        <button type="button" className="btn-ghost h-7 px-2 text-[11px]" onClick={onNone}>
          Clear
        </button>
      </div>

      {PANEL_PERMISSIONS.map((permission) => {
        // Nothing the viewer does not hold can be handed on, so it is shown
        // disabled with the reason rather than hidden - a missing checkbox
        // reads as a missing feature.
        const allowed = grantable.includes(permission);
        const elevated = PANEL_PERMISSIONS_GRANTING_ACCESS.includes(permission);

        return (
          <label
            key={permission}
            className={`flex items-start gap-2 text-sm ${
              allowed ? 'cursor-pointer text-ink-900' : 'cursor-not-allowed text-ink-600'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-brand-500"
              checked={selected.includes(permission)}
              disabled={!allowed}
              onChange={(event) => onToggle(permission, event.target.checked)}
            />
            <span>
              {PANEL_PERMISSION_LABELS[permission]}
              {elevated ? (
                <span className="ml-1.5 badge bg-power-restart/20 text-power-restart">
                  can widen access
                </span>
              ) : null}
              {!allowed ? (
                <span className="mt-0.5 block text-xs">You do not hold this yourself.</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function usePermissionSelection(initial: string[], grantable: string[]) {
  const [selected, setSelected] = useState<string[]>(initial);

  const toggle = (permission: PanelPermission, on: boolean) =>
    setSelected((current) =>
      on ? [...new Set([...current, permission])] : current.filter((p) => p !== permission),
    );

  // "Full access" means everything the viewer can actually pass on, not
  // everything that exists - otherwise the save would be rejected server-side.
  const all = () => setSelected(PANEL_PERMISSIONS.filter((p) => grantable.includes(p)));
  const none = () => setSelected([]);

  return { selected, toggle, all, none };
}

function CreateSubAdmin({
  grantable,
  onCreated,
  onError,
}: {
  grantable: string[];
  onCreated: (result: { username: string; password: string }) => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const { selected, toggle, all, none } = usePermissionSelection([], grantable);

  async function create() {
    setSaving(true);
    try {
      const result = await api.post<{ account: { username: string }; temporaryPassword: string }>(
        '/admin/panel-accounts',
        { username: username.trim(), panelPermissions: selected },
      );
      await onCreated({ username: result.account.username, password: result.temporaryPassword });
      setUsername('');
      none();
    } catch (caught) {
      onError(caught, 'Could not create the account.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card space-y-3 border-brand-500/40">
      <h3 className="text-sm font-bold">New sub-admin</h3>

      <div>
        <label className="label" htmlFor="sub-admin-username">
          Username
        </label>
        <input
          id="sub-admin-username"
          className="input"
          value={username}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <PermissionPicker selected={selected} grantable={grantable} onToggle={toggle} onAll={all} onNone={none} />

      <button
        type="button"
        className="btn-primary w-full"
        onClick={() => void create()}
        disabled={saving || username.trim().length < 3}
      >
        {saving ? 'Creating…' : 'Create sub-admin'}
      </button>
    </div>
  );
}

function EditSubAdmin({
  account,
  grantable,
  onDone,
  onCancel,
  onError,
}: {
  account: PanelAccountRow;
  grantable: string[];
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(account.status);
  const { selected, toggle, all, none } = usePermissionSelection(account.panelPermissions, grantable);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/admin/panel-accounts/${account.id}`, {
        panelPermissions: selected,
        status,
      });
      await onDone();
    } catch (caught) {
      onError(caught, 'Could not update the account.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-ink-300 p-3">
      <PermissionPicker selected={selected} grantable={grantable} onToggle={toggle} onAll={all} onNone={none} />

      <div>
        <label className="label" htmlFor={`status-${account.id}`}>
          Account status
        </label>
        <select
          id={`status-${account.id}`}
          className="input"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="DISABLED">Disabled</option>
        </select>
      </div>

      <p className="text-xs leading-relaxed text-ink-700">
        Saving signs this account out everywhere, so a permission you take away stops working now
        rather than whenever their session happens to expire.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-primary flex-1" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
