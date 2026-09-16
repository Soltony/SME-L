import {
  MODULE_KEYS,
  parentModuleKey,
  subModuleKey,
  subModulesFor,
} from './route-permissions';
import type { PermissionAction, Permissions } from './types';

export const SUPER_ADMIN_ROLE = 'Super Admin';

export function parsePermissions(raw: unknown): Permissions {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Permissions;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? (parsed as Permissions) : {};
  } catch {
    return {};
  }
}

/** Every module granted with at least one action. */
export function grantedModules(permissions: Permissions): Set<string> {
  const set = new Set<string>();
  for (const [key, actions] of Object.entries(permissions || {})) {
    if (actions && Object.values(actions).some(Boolean)) set.add(key.toLowerCase());
  }
  return set;
}

export function hasPermission(
  user: { role?: string; permissions?: Permissions } | null | undefined,
  moduleKey: string,
  action: PermissionAction
): boolean {
  if (!user) return false;
  if (user.role === SUPER_ADMIN_ROLE) return true;

  const key = moduleKey?.toLowerCase();
  const own = user.permissions?.[key];
  if (own) return !!own[action];

  // A role saved before its module was split into tabs carries only the parent
  // key. Inheriting from it keeps those roles working as they did rather than
  // silently revoking every tab; an explicit tab grant always wins.
  const parent = parentModuleKey(key ?? '');
  return parent !== key ? !!user.permissions?.[parent]?.[action] : false;
}

/**
 * True when the module itself, or any tab under it, grants the action. For
 * capabilities shared by several tabs — uploading artwork, say — rather than
 * belonging to one of them.
 */
export function hasModuleAccess(
  user: { role?: string; permissions?: Permissions } | null | undefined,
  moduleKey: string,
  action: PermissionAction
): boolean {
  if (hasPermission(user, moduleKey, action)) return true;
  return subModulesFor(moduleKey).some((sub) =>
    hasPermission(user, subModuleKey(moduleKey, sub.tab), action)
  );
}

/** What one tab lets the current user do, once they are allowed to open it. */
export interface TabPermission {
  /** The tab's `value` in the page's `<Tabs>`. */
  tab: string;
  label: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/** The tabs of `moduleKey` this user may open, in registry order. */
export function readableTabs(
  user: { role?: string; permissions?: Permissions } | null | undefined,
  moduleKey: string
): TabPermission[] {
  const out: TabPermission[] = [];
  for (const sub of subModulesFor(moduleKey)) {
    const key = subModuleKey(moduleKey, sub.tab);
    if (!hasPermission(user, key, 'read')) continue;
    out.push({
      tab: sub.tab,
      label: sub.label,
      canCreate: hasPermission(user, key, 'create'),
      canUpdate: hasPermission(user, key, 'update'),
      canDelete: hasPermission(user, key, 'delete'),
    });
  }
  return out;
}

/**
 * Materializes tab grants for roles saved before their module was split into
 * tabs, mirroring how `hasPermission` resolves them at runtime. The role
 * builder edits the expanded matrix, so opening and saving an old role cannot
 * quietly revoke the tabs it used to imply.
 */
export function expandTabPermissions(permissions: Permissions): Permissions {
  const out: Permissions = { ...permissions };
  for (const key of MODULE_KEYS) {
    const parent = parentModuleKey(key);
    if (parent === key || out[key]) continue;
    if (out[parent]) out[key] = { ...out[parent] };
  }
  return out;
}

/** A blank matrix with every module/action false — the starting point in the role builder. */
export function emptyPermissionMatrix(): Permissions {
  const out: Permissions = {};
  for (const key of MODULE_KEYS) {
    out[key] = { read: false, create: false, update: false, delete: false, approve: false };
  }
  return out;
}

export function fullPermissionMatrix(): Permissions {
  const out: Permissions = {};
  for (const key of MODULE_KEYS) {
    out[key] = { read: true, create: true, update: true, delete: true, approve: true };
  }
  return out;
}

/** Drops unknown module keys so a stale role can't grant access to something removed. */
export function sanitizePermissions(input: Permissions): Permissions {
  const out: Permissions = {};
  for (const key of MODULE_KEYS) {
    const actions = input?.[key];
    if (!actions) continue;
    out[key] = {
      read: !!actions.read,
      create: !!actions.create,
      update: !!actions.update,
      delete: !!actions.delete,
      approve: !!actions.approve,
    };
  }
  return out;
}

/** First admin page the user is allowed to open — used for post-login landing. */
export function firstAllowedPath(
  permissions: Permissions,
  role: string,
  paths: { path: string; moduleKey: string }[]
): string {
  if (role === SUPER_ADMIN_ROLE) return '/admin';
  const granted = grantedModules(permissions);
  const match = paths.find((p) => granted.has(p.moduleKey));
  return match?.path ?? '/admin/no-access';
}
