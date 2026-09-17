import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_PUBLIC_ROUTES,
  API_ROLE_CONSTRAINTS,
  BORROWER_API_PREFIX,
  BORROWER_API_PUBLIC_PREFIX,
  BORROWER_PAGE_PREFIXES,
  PERMISSION_EXEMPT_ROUTES,
  findAdminRoute,
  isSelfGuardedAdminApi,
  moduleKeyFor,
  moduleKeyForApiPath,
} from '@/lib/route-permissions';
import { hasPermission } from '@/lib/permissions';
import { applySecurityHeaders, buildCsp, isPrivatePath, NO_STORE } from '@/lib/security-headers';
import { additionalTrustedOrigins, checkRequestOrigin } from '@/lib/request-context';
import type { Permissions } from '@/lib/types';

/**
 * Every request passes through here: CSRF origin check, session and module
 * permission for the console, session presence for the borrower app, and the
 * security headers. Matching by exclusion means a route added later is covered
 * the day it is written.
 *
 * The previous SME middleware enumerated routes, so the borrower pages shipped
 * with no CSP, and it checked `allowedRoles` while the menu declared `roles`,
 * so role restrictions were never enforced.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};

const BORROWER_COOKIE = 'borrowerSession';

/** Machine-to-machine endpoints with their own authentication and no browser origin. */
const ORIGIN_EXEMPT_PREFIXES = ['/api/payment/callback', '/api/payment-callback', '/api/cron'];

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isUnder(path: string, prefixes: string[]) {
  return prefixes.some((p) => path === p || path.startsWith(p + '/'));
}

function readSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/** Rewrites the forwarded Cookie header so this request carries renewed tokens. */
function applyRenewedCookies(headers: Headers, setCookies: string[]) {
  if (setCookies.length === 0) return;
  const jar = new Map<string, string>();
  for (const pair of (headers.get('cookie') || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  for (const cookie of setCookies) {
    const [assignment] = cookie.split(';');
    const separator = assignment.indexOf('=');
    if (separator < 1) continue;
    const name = assignment.slice(0, separator).trim();
    const value = assignment.slice(separator + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  const rebuilt = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  if (rebuilt) headers.set('cookie', rebuilt);
  else headers.delete('cookie');
}

export default async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp({ nonce, allowEval: process.env.NODE_ENV !== 'production' });
  let renewedCookies: string[] = [];

  const finish = (res: NextResponse) => {
    for (const cookie of renewedCookies) res.headers.append('Set-Cookie', cookie);
    applySecurityHeaders(res.headers, csp, nonce);
    if (isPrivatePath(path)) {
      res.headers.set('Cache-Control', NO_STORE);
      res.headers.set('Pragma', 'no-cache');
      res.headers.set('Expires', '0');
      res.headers.set('Vary', 'Origin, Cookie');
    }
    return res;
  };

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-pathname', path);
  const passthrough = () => NextResponse.next({ request: { headers: requestHeaders } });

  const deny = (status: number, redirectTo: string, message?: string) => {
    if (path.startsWith('/api/')) {
      const error = message ?? (status === 401 ? 'Not authenticated' : 'Forbidden');
      return finish(NextResponse.json({ error }, { status }));
    }
    return finish(NextResponse.redirect(new URL(redirectTo, req.nextUrl.origin)));
  };

  // ---- CSRF: same-origin check on every state-changing request ----
  if (STATE_CHANGING.has(req.method) && !isUnder(path, ORIGIN_EXEMPT_PREFIXES)) {
    const verdict = checkRequestOrigin(req.headers, req.nextUrl, additionalTrustedOrigins());
    if (verdict === 'cross-origin') {
      return deny(403, '/admin/login', 'Cross-origin request rejected.');
    }
  }

  const hasBorrowerCookie = Boolean(req.cookies.get(BORROWER_COOKIE)?.value);

  // ---- Front door: borrowers enter through /connect, staff through /admin ----
  if (path === '/') {
    return finish(
      NextResponse.redirect(new URL(hasBorrowerCookie ? '/home' : '/admin/login', req.nextUrl.origin))
    );
  }

  // ---- Borrower app: requires a signed borrower session (verified by the handler) ----
  const isBorrowerPage = isUnder(path, BORROWER_PAGE_PREFIXES);
  const isBorrowerApi = isUnder(path, [BORROWER_API_PREFIX]) && !isUnder(path, [BORROWER_API_PUBLIC_PREFIX]);
  if ((isBorrowerPage || isBorrowerApi) && !hasBorrowerCookie) {
    const redirect = new URL('/connect', req.nextUrl.origin);
    redirect.searchParams.set('next', path);
    return deny(401, redirect.pathname + redirect.search, 'Your session has expired. Please reopen the app.');
  }

  // ---- Admin console: session + module permission ----
  if (!isUnder(path, ['/admin', '/api/admin'])) return finish(passthrough());
  if (ADMIN_PUBLIC_ROUTES.includes(path) || path.startsWith('/api/admin/auth')) {
    return finish(passthrough());
  }

  let session: {
    authenticated?: boolean;
    role?: string;
    permissions?: Permissions;
    passwordChangeRequired?: boolean;
  } | null = null;

  try {
    const response = await fetch(new URL('/api/admin/auth/session', req.nextUrl.origin), {
      headers: { cookie: req.headers.get('cookie') || '', 'x-auth-session-check': 'proxy' },
      cache: 'no-store',
    });
    if (response.ok) {
      session = await response.json();
      renewedCookies = readSetCookies(response.headers);
      applyRenewedCookies(requestHeaders, renewedCookies);
    }
  } catch (error) {
    console.error('[proxy] session check failed', error);
    return deny(401, '/admin/login');
  }

  if (!session?.authenticated) return deny(401, '/admin/login');

  if (session.passwordChangeRequired) {
    const allowed = path === '/admin/change-password' || path.startsWith('/api/admin/auth/change-password');
    if (!allowed) return deny(403, '/admin/change-password', 'Password change required');
  }

  if (PERMISSION_EXEMPT_ROUTES.includes(path)) return finish(passthrough());
  if (session.role === 'Super Admin') return finish(passthrough());

  const permissions = session.permissions || {};
  const isApi = path.startsWith('/api/');
  if (isApi && isSelfGuardedAdminApi(path)) return finish(passthrough());

  const route = isApi ? undefined : findAdminRoute(path);
  const moduleKey = isApi ? moduleKeyForApiPath(path) : route ? moduleKeyFor(route.label) : undefined;

  // Deny by default: an unmapped admin page or API is not reachable.
  if (!moduleKey) return deny(403, '/admin/no-access');
  // Through hasPermission, so a role saved before a module was split or moved
  // reaches it exactly as the page and API guards would let it.
  if (!hasPermission({ role: session.role, permissions }, moduleKey, 'read')) return deny(403, '/admin/no-access');

  const requiredRoles = isApi ? API_ROLE_CONSTRAINTS[moduleKey] : route?.roles;
  if (requiredRoles?.length) {
    const allowed = requiredRoles.map((r) => r.toLowerCase());
    if (!session.role || !allowed.includes(session.role.toLowerCase())) {
      return deny(403, '/admin/no-access');
    }
  }

  return finish(passthrough());
}
