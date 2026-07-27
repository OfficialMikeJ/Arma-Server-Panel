'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@asp/shared';
import { api, ApiError } from '@/lib/api';
import { ServerTabs } from '@/components/panel/ServerTabs';

/**
 * Sub-users on one server.
 *
 * Two rules shape this screen:
 *
 *   * Nobody edits their own access. Not the person holding server:members
 *     either - if they need more, they request it, and somebody else decides.
 *
 *   * Nobody hands on what they do not hold. Permissions the viewer lacks are
 *     shown disabled with the reason rather than hidden, because a missing
 *     checkbox reads as a missing feature.
 *
 * Both are enforced by the API; this only decides what to draw.
 */

interface MemberRow {
  id: string;
  role: string;
  permissions: string[];
  effectivePermissions: string[];
  account: { id: string; username: string; discord: { username: string | null } | null };
}

const PERMISSION_LABELS: Record<Permission, string> = {
  'server:read': 'View the server',
  'server:power': 'Start, stop and restart',
  'server:reinstall': 'Reinstall',
  'server:delete': 'Delete the server',
  'server:settings': 'Change settings and game configuration',
  'server:resources': 'Change CPU, memory and storage',
  'server:console.read': 'Read the console',
  'server:console.write': 'Send console commands',
  'server:mods': 'Manage mods',
  'server:files.read': 'Browse and download files',
  'server:files.write': 'Edit, upload and delete files',
  'server:backups': 'Create and restore backups',
  'server:network': 'Open ports and change networking',
  'server:members': 'Manage sub-users',
  'server:integrations': 'Manage Discord and Pushover notifications',
  'server:ai': 'Use the AI assistant',
  'server:audit': 'Read this server’s audit trail',
};

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [grantable, setGrantable] = useState<string[]>([]);
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [identity, result] = await Promise.all([
        api.get<{ account: { id: string } }>('/account'),
        api.get<{ members: MemberRow[]; grantable: string[] }>(`/servers/${id}/members`),
      ]);
      setMyAccountId(identity.account.id);
      setMembers(result.members);
      setGrantable(result.grantable);
      setCanManage(result.grantable.includes('server:members'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load sub-users.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(caught: unknown, fallback: string) {
    setError(caught instanceof ApiError ? caught.message : fallback);
  }

  async function remove(memberId: string) {
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/servers/${id}/members/${memberId}`);
      setNotice('Removed.');
      await load();
    } catch (caught) {
      fail(caught, 'Could not remove that sub-user.');
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <ServerTabs serverId={id} />
        <div className="card h-64 animate-pulse bg-ink-200" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ServerTabs serverId={id} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-extrabold uppercase tracking-wide">Sub-users</h1>
        {canManage ? (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add sub-user'}
          </button>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-ink-700">
        Each sub-user gets exactly the permissions ticked for them.{' '}
        {canManage
          ? 'You can only grant what you hold yourself, and you cannot change your own access.'
          : 'You do not manage sub-users on this server — ask an administrator, or request the permission you need.'}
      </p>

      {adding ? (
        <AddMember
          serverId={id}
          grantable={grantable}
          onDone={async () => {
            setAdding(false);
            await load();
          }}
          onError={fail}
        />
      ) : null}

      {members.length === 0 ? (
        <div className="card text-center text-sm text-ink-800">
          No sub-users yet. Only the owner can reach this server.
        </div>
      ) : (
        members.map((member) => (
          <div key={member.id} className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-bold">{member.account.username}</span>
                {member.account.discord?.username ? (
                  <span className="ml-2 text-xs text-ink-700">
                    Discord: {member.account.discord.username}
                  </span>
                ) : null}
              </div>
              <span className="badge bg-ink-300 uppercase text-ink-900">{member.role}</span>
            </div>

            {editing === member.id ? (
              <EditMember
                serverId={id}
                member={member}
                grantable={grantable}
                onDone={async () => {
                  setEditing(null);
                  await load();
                }}
                onCancel={() => setEditing(null)}
                onError={fail}
              />
            ) : (
              <>
                <ul className="space-y-0.5 text-xs text-ink-800">
                  {member.effectivePermissions.map((permission) => (
                    <li key={permission}>
                      · {PERMISSION_LABELS[permission as Permission] ?? permission}
                    </li>
                  ))}
                </ul>

                {canManage && member.account.id !== myAccountId ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      className="btn-secondary flex-1"
                      onClick={() => setEditing(member.id)}
                    >
                      Edit permissions
                    </button>
                    <button type="button" className="btn-stop" onClick={() => void remove(member.id)}>
                      Remove
                    </button>
                  </div>
                ) : member.account.id === myAccountId ? (
                  <p className="text-xs text-ink-700">
                    This is you. Nobody changes their own access — request a change instead.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ))
      )}

      <RequestAccess serverId={id} held={grantable} onError={fail} onDone={() => setNotice('Request sent.')} />

      {notice ? (
        <p className="rounded-md bg-power-start/10 p-3 text-sm text-power-start">{notice}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md bg-power-stop/10 p-3 text-sm text-power-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PermissionPicker({
  selected,
  grantable,
  onChange,
}: {
  selected: string[];
  grantable: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {PERMISSIONS.map((permission) => {
        const allowed = grantable.includes(permission);
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
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...new Set([...selected, permission])]
                    : selected.filter((p) => p !== permission),
                )
              }
            />
            <span>
              {PERMISSION_LABELS[permission]}
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

function RolePresets({ grantable, onPick }: { grantable: string[]; onPick: (next: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {(['admin', 'operator', 'viewer'] as const).map((role) => (
        <button
          key={role}
          type="button"
          className="btn-ghost h-7 px-2 text-[11px] capitalize"
          // Narrowed to what the viewer can pass on, so a preset never produces
          // a save the server is going to reject.
          onClick={() => onPick(ROLE_PERMISSIONS[role].filter((p) => grantable.includes(p)))}
        >
          {role} preset
        </button>
      ))}
      <button type="button" className="btn-ghost h-7 px-2 text-[11px]" onClick={() => onPick([])}>
        Clear
      </button>
    </div>
  );
}

function AddMember({
  serverId,
  grantable,
  onDone,
  onError,
}: {
  serverId: string;
  grantable: string[];
  onDone: () => void | Promise<void>;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [identifier, setIdentifier] = useState('');
  const [identifierType, setIdentifierType] = useState<'username' | 'discord_id'>('username');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [permissions, setPermissions] = useState<string[]>([
    ...ROLE_PERMISSIONS.viewer.filter((p) => grantable.includes(p)),
  ]);
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try {
      await api.post(`/servers/${serverId}/members`, {
        identifier: identifier.trim(),
        identifierType,
        role,
        permissionOverrides: permissions,
      });
      await onDone();
    } catch (caught) {
      onError(caught, 'Could not add that sub-user.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card space-y-3 border-brand-500/40">
      <h2 className="text-sm font-bold">Add a sub-user</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="member-identifier">
            Panel username or Discord ID
          </label>
          <input
            id="member-identifier"
            className="input"
            value={identifier}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="member-identifier-type">
            Look them up by
          </label>
          <select
            id="member-identifier-type"
            className="input"
            value={identifierType}
            onChange={(event) => setIdentifierType(event.target.value as 'username' | 'discord_id')}
          >
            <option value="username">Panel username</option>
            <option value="discord_id">Discord user ID</option>
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="member-role">
          Role
        </label>
        <select
          id="member-role"
          className="input"
          value={role}
          onChange={(event) => {
            const next = event.target.value as 'admin' | 'operator' | 'viewer';
            setRole(next);
            setPermissions(ROLE_PERMISSIONS[next].filter((p) => grantable.includes(p)));
          }}
        >
          <option value="viewer">Viewer</option>
          <option value="operator">Operator</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <RolePresets grantable={grantable} onPick={setPermissions} />
      <PermissionPicker selected={permissions} grantable={grantable} onChange={setPermissions} />

      <button
        type="button"
        className="btn-primary w-full"
        onClick={() => void add()}
        disabled={saving || identifier.trim().length === 0 || permissions.length === 0}
      >
        {saving ? 'Adding…' : 'Add sub-user'}
      </button>
    </div>
  );
}

function EditMember({
  serverId,
  member,
  grantable,
  onDone,
  onCancel,
  onError,
}: {
  serverId: string;
  member: MemberRow;
  grantable: string[];
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [permissions, setPermissions] = useState<string[]>(member.effectivePermissions);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/servers/${serverId}/members/${member.id}`, { permissions });
      await onDone();
    } catch (caught) {
      onError(caught, 'Could not update those permissions.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-ink-300 p-3">
      <RolePresets grantable={grantable} onPick={setPermissions} />
      <PermissionPicker selected={permissions} grantable={grantable} onChange={setPermissions} />

      <p className="text-xs leading-relaxed text-ink-700">
        Saving signs this account out everywhere, so anything you take away stops working now
        rather than whenever their session happens to expire.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() => void save()}
          disabled={saving || permissions.length === 0}
        >
          {saving ? 'Saving…' : 'Save permissions'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Asks for permissions the viewer does not have. Asking grants nothing. */
function RequestAccess({
  serverId,
  held,
  onDone,
  onError,
}: {
  serverId: string;
  held: string[];
  onDone: () => void;
  onError: (caught: unknown, fallback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const missing = PERMISSIONS.filter((permission) => !held.includes(permission));
  if (missing.length === 0) return null;

  async function send() {
    setSaving(true);
    try {
      await api.post('/access-requests', { serverId, requested, reason: reason.trim() });
      setOpen(false);
      setRequested([]);
      setReason('');
      onDone();
    } catch (caught) {
      onError(caught, 'Could not send that request.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide">Request more access</h2>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Ask for a permission'}
        </button>
      </div>

      {open ? (
        <>
          <p className="text-xs leading-relaxed text-ink-700">
            An administrator decides. Nothing changes until they do, and they can grant part of what
            you ask for.
          </p>

          <div className="space-y-1.5">
            {missing.map((permission) => (
              <label key={permission} className="flex cursor-pointer items-start gap-2 text-sm text-ink-900">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-brand-500"
                  checked={requested.includes(permission)}
                  onChange={(event) =>
                    setRequested((current) =>
                      event.target.checked
                        ? [...new Set([...current, permission])]
                        : current.filter((p) => p !== permission),
                    )
                  }
                />
                <span>{PERMISSION_LABELS[permission]}</span>
              </label>
            ))}
          </div>

          <div>
            <label className="label" htmlFor="request-reason">
              Why do you need it?
            </label>
            <textarea
              id="request-reason"
              className="input h-24"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="At least a sentence — whoever reads this has to decide on it."
            />
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void send()}
            disabled={saving || requested.length === 0 || reason.trim().length < 10}
          >
            {saving ? 'Sending…' : 'Send request'}
          </button>
        </>
      ) : null}
    </section>
  );
}
