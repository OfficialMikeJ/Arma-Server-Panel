/**
 * Panel-scoped permissions.
 *
 * Deliberately separate from the server permission vocabulary, because they
 * answer a different question. `server:*` asks "what may this account do inside
 * one game server". `panel:*` asks "what may this account do to the panel
 * itself" - add a node, read the audit trail, create accounts.
 *
 * Keeping them apart is what makes a sub-admin possible. A full ADMIN gets
 * implicit admin on every server, which is the wrong shape for someone hired to
 * manage capacity or review logs and who has no business in a customer's server
 * files. A SUB_ADMIN holds panel permissions only: to touch a game server they
 * must be added to it as a member, exactly like any other account.
 */

export const PANEL_PERMISSIONS = [
  'panel:nodes.read',
  'panel:nodes.write',
  'panel:accounts.read',
  'panel:accounts.write',
  'panel:requests.review',
  'panel:audit.read',
  'panel:telemetry.read',
  'panel:settings',
] as const;

export type PanelPermission = (typeof PANEL_PERMISSIONS)[number];

export function isPanelPermission(value: unknown): value is PanelPermission {
  return typeof value === 'string' && (PANEL_PERMISSIONS as readonly string[]).includes(value);
}

/** Shown next to each checkbox, so a grant is made with its meaning in view. */
export const PANEL_PERMISSION_LABELS: Readonly<Record<PanelPermission, string>> = Object.freeze({
  'panel:nodes.read': 'View nodes and their capacity',
  'panel:nodes.write': 'Add, edit and re-check nodes, including port ranges',
  'panel:accounts.read': 'View panel accounts',
  'panel:accounts.write': 'Create and edit sub-admin accounts and their permissions',
  'panel:requests.review': 'Approve or deny access requests',
  'panel:audit.read': 'Read the audit trail',
  'panel:telemetry.read': 'View platform telemetry and usage counters',
  'panel:settings': 'Change platform settings, including registration',
});

/**
 * Grants that let an account widen access - its own or anyone else's.
 *
 * Called out so the UI can mark them and so a reviewer can see at a glance that
 * they are handing over the ability to hand things over. Anyone holding both
 * accounts.write and requests.review can effectively promote themselves, which
 * is a reasonable thing to grant deliberately and a bad thing to grant by
 * accident.
 */
export const PANEL_PERMISSIONS_GRANTING_ACCESS: readonly PanelPermission[] = Object.freeze([
  'panel:accounts.write',
  'panel:requests.review',
]);

/** A ready-made "everything" set, for the full-access option in the UI. */
export const ALL_PANEL_PERMISSIONS: readonly PanelPermission[] = PANEL_PERMISSIONS;

/**
 * Whether an account signs in through the administrator flow.
 *
 * Sub-admins hold a password and use the same login and step-up screens as a
 * full administrator - they are simply scoped once they are through. Every
 * check that gates those flows must ask this rather than `type === 'ADMIN'`,
 * or a sub-admin is locked out of the panel entirely.
 *
 * Note this is *not* the check for implicit server access. That one is
 * deliberately `type === 'ADMIN'`, so a sub-admin never inherits it.
 */
export function isPanelAdministrator(account: {
  type: string;
  isPlatformOwner?: boolean;
}): boolean {
  return account.type === 'ADMIN' || account.type === 'SUB_ADMIN' || Boolean(account.isPlatformOwner);
}

/**
 * What an account may do to the panel.
 *
 * ADMIN and the platform owner hold everything; that is what distinguishes them
 * from a sub-admin. A plain USER holds nothing, whatever is in the column.
 */
export function panelPermissionsFor(account: {
  type: string;
  isPlatformOwner?: boolean;
  panelPermissions?: string[] | null;
}): Set<PanelPermission> {
  if (account.type === 'ADMIN' || account.isPlatformOwner) {
    return new Set(PANEL_PERMISSIONS);
  }
  if (account.type !== 'SUB_ADMIN') return new Set();
  return new Set((account.panelPermissions ?? []).filter(isPanelPermission));
}
