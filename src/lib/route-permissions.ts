/**
 * Authoritative route → permission registry.
 *
 * Deliberately free of React and icon imports so the proxy can use it without
 * pulling the UI layer in. `menu-items.ts` decorates these same entries with
 * icons for the sidebar.
 *
 * The previous SME console declared `roles` on its menu while the middleware
 * checked a different property (`allowedRoles`), so role restrictions were
 * never enforced. Here one list drives the proxy, the API guard, the sidebar
 * and the role builder, so they cannot drift apart.
 */

export interface SubModule {
  /** Matches the tab's `value` in the page's `<Tabs>`. */
  tab: string;
  label: string;
}

export interface AdminRoute {
  path: string;
  label: string;
  /** Role names allowed here on top of the module permission check. */
  roles?: string[];
  subModules?: SubModule[];
}

export const ADMIN_ROUTES: AdminRoute[] = [
  { path: '/admin', label: 'Dashboard' },
  { path: '/admin/applications', label: 'Applications' },
  { path: '/admin/loans', label: 'Loans' },
  { path: '/admin/disbursements', label: 'Disbursements' },
  { path: '/admin/repayments', label: 'Repayments' },
  { path: '/admin/borrowers', label: 'Borrowers' },
  { path: '/admin/providers', label: 'Providers' },
  { path: '/admin/products', label: 'Products' },
  { path: '/admin/credit-scoring', label: 'Credit Scoring' },
  { path: '/admin/accounting', label: 'Accounting' },
  { path: '/admin/reports', label: 'Reports' },
  { path: '/admin/approvals', label: 'Approvals' },
  { path: '/admin/audit-logs', label: 'Audit Logs', roles: ['Super Admin', 'Auditor'] },
  { path: '/admin/users', label: 'Users', roles: ['Super Admin'] },
  { path: '/admin/access-control', label: 'Access Control', roles: ['Super Admin'] },
  { path: '/admin/settings', label: 'Settings' },
];

export function moduleKeyFor(label: string) {
  return label.toLowerCase().replace(/\s+/g, '-');
}

export function subModuleKey(parentKey: string, tab: string) {
  return `${parentKey}.${tab}`;
}

export function parentModuleKey(key: string) {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

export function subModulesFor(parentKey: string): SubModule[] {
  return ADMIN_ROUTES.find((route) => moduleKeyFor(route.label) === parentKey)?.subModules ?? [];
}

export const PARENT_MODULE_KEYS = ADMIN_ROUTES.map((r) => moduleKeyFor(r.label));

/** Every key a role may be granted. `sanitizePermissions` drops anything else. */
export const MODULE_KEYS = ADMIN_ROUTES.flatMap((route) => {
  const key = moduleKeyFor(route.label);
  return [key, ...(route.subModules ?? []).map((sub) => subModuleKey(key, sub.tab))];
});

/** Pages any authenticated staff member may open, whatever their permissions. */
export const PERMISSION_EXEMPT_ROUTES = ['/admin/no-access', '/admin/change-password'];

export const ADMIN_PUBLIC_ROUTES = ['/admin/login'];

/** Longest full-segment prefix match, so /admin/loans never matches /admin/loans-x. */
export function findAdminRoute(path: string): AdminRoute | undefined {
  let best: AdminRoute | undefined;
  for (const route of ADMIN_ROUTES) {
    const exact = path === route.path;
    const segmentPrefix = path.startsWith(route.path + '/');
    if ((exact || segmentPrefix) && (!best || route.path.length > best.path.length)) {
      best = route;
    }
  }
  return best;
}

export const API_MODULE_MAP: Record<string, string> = {
  '/api/admin/dashboard': 'dashboard',
  '/api/admin/applications': 'applications',
  '/api/admin/loans': 'loans',
  '/api/admin/disbursements': 'disbursements',
  '/api/admin/repayments': 'repayments',
  '/api/admin/borrowers': 'borrowers',
  '/api/admin/providers': 'providers',
  '/api/admin/products': 'products',
  '/api/admin/credit-scoring': 'credit-scoring',
  '/api/admin/accounting': 'accounting',
  '/api/admin/reports': 'reports',
  '/api/admin/approvals': 'approvals',
  '/api/admin/audit-logs': 'audit-logs',
  '/api/admin/users': 'users',
  '/api/admin/roles': 'access-control',
  '/api/admin/settings': 'settings',
};

/**
 * Role names required to call an admin API, over and above the module grant.
 * Mirrors the page constraint, so a Super-Admin-only page never has an API
 * behind it that any module grant can call.
 */
export const API_ROLE_CONSTRAINTS: Record<string, string[]> = Object.fromEntries(
  ADMIN_ROUTES.filter((route) => route.roles?.length).map((route) => [
    moduleKeyFor(route.label),
    route.roles as string[],
  ])
);

/**
 * Admin APIs that authorize themselves because their permission cannot be
 * expressed as one module key. Everything absent from both this list and
 * `API_MODULE_MAP` is refused, so a new endpoint cannot ship unguarded.
 */
export const SELF_GUARDED_ADMIN_API: string[] = [];

export function isSelfGuardedAdminApi(path: string): boolean {
  return SELF_GUARDED_ADMIN_API.some((p) => path === p || path.startsWith(p + '/'));
}

export function moduleKeyForApiPath(path: string): string | undefined {
  let best: string | undefined;
  let bestLen = 0;
  for (const [prefix, key] of Object.entries(API_MODULE_MAP)) {
    if ((path === prefix || path.startsWith(prefix + '/')) && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return best;
}

// --------------------------------------
// BORROWER (mini-app) ROUTES
// --------------------------------------

/** Borrower pages. All of them show personal financial data, so all need a session. */
export const BORROWER_PAGE_PREFIXES = ['/home', '/products', '/loans', '/applications', '/profile'];

/** Borrower APIs. `/api/app/auth/*` is where a session is obtained, so it stays open. */
export const BORROWER_API_PREFIX = '/api/app';
export const BORROWER_API_PUBLIC_PREFIX = '/api/app/auth';
