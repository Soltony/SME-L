import { cookies } from 'next/headers';
import prisma from './prisma';
import {
  ACCESS_TOKEN_EXP,
  REFRESH_TOKEN_DAYS,
  decryptJwt,
  encryptJwt,
  expiryFromDays,
  uuid,
  verifyJwt,
} from './jwt';
import { parsePermissions } from './permissions';
import type { SessionUser } from './types';
import { isTestLoginEnabled } from './dev-switches';

export const ACCESS_COOKIE = 'accessToken';
export const REFRESH_COOKIE = 'refreshToken';
export const BORROWER_COOKIE = 'borrowerSession';

/**
 * Cookies are marked Secure everywhere except an explicitly local run.
 *
 * Testing `NODE_ENV === 'production'` puts the burden the wrong way round: a
 * deployment that forgets to set it ships session cookies that travel in the
 * clear, and nothing about the running app looks wrong. Defaulting to Secure
 * means the only way to get a plain-HTTP cookie is to say so.
 */
function isLocalRuntime() {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

/**
 * Administrative cookies are SameSite=Strict.
 *
 * Lax still accompanies a cross-site top-level navigation, which is enough for
 * an attacker's page to drive an authenticated GET into the console. Nothing
 * legitimately enters the admin surface from another site, so Strict costs
 * nothing here.
 */
const adminCookieBase = {
  httpOnly: true,
  secure: !isLocalRuntime(),
  sameSite: 'strict' as const,
  path: '/',
};

/**
 * The borrower cookie stays Lax, deliberately.
 *
 * The mini-app is entered by the super app navigating the webview to `/connect`
 * — a cross-site top-level navigation. Under Strict the cookie would be
 * withheld on exactly that hop and every deep link would bounce back through a
 * fresh token exchange. It is HttpOnly and Secure, it carries no privileged
 * capability, and the server-side origin check in `src/proxy.ts` covers the
 * state-changing requests that SameSite would otherwise be alone in guarding.
 */
const borrowerCookieBase = {
  httpOnly: true,
  secure: !isLocalRuntime(),
  sameSite: 'lax' as const,
  path: '/',
};

// --------------------------------------
// SESSION LIFETIME
// --------------------------------------

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * How long a session may sit unused before it is revoked.
 *
 * Rotation used to extend the expiry on every refresh, so an active session —
 * including one being driven by a stolen token — never expired at all. These
 * two limits are what bound it: idle time since the last request, and total
 * time since sign-in. Both are configurable, both are clamped, so a typo in the
 * environment cannot widen them to something meaningless.
 */
export function idleTimeoutMs(): number {
  const configured = Number(process.env.SESSION_IDLE_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 30;
  return clamp(minutes, 5, 240) * 60_000;
}

export function absoluteLifetimeMs(): number {
  const configured = Number(process.env.SESSION_ABSOLUTE_HOURS);
  const hours = Number.isFinite(configured) && configured > 0 ? configured : 8;
  return clamp(hours, 1, 72) * 60 * 60_000;
}

/** Why a session was refused, or null when it is still within both limits. */
export function sessionLifetimeBreach(record: {
  createdAt: Date;
  lastActivity: Date;
}): 'idle' | 'absolute' | null {
  const now = Date.now();
  if (now - record.lastActivity.getTime() > idleTimeoutMs()) return 'idle';
  if (now - record.createdAt.getTime() > absoluteLifetimeMs()) return 'absolute';
  return null;
}

async function revokeSession(id: string, reason: string) {
  await prisma.session
    .update({ where: { id }, data: { revoked: true, jti: null } })
    .catch(() => null);
  console.warn(`[session] revoked ${id}: ${reason}`);
}

// --------------------------------------
// ADMIN SESSIONS (DB-backed, rotating refresh token)
// --------------------------------------

export async function createAdminSession(
  userId: string,
  meta?: { ipAddress?: string | null; userAgent?: string | null }
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found during session creation.');

  // The refresh token never outlives the absolute session cap, whatever
  // REFRESH_TOKEN_DAYS says — the cap is the shorter of the two by design.
  const refreshExpiresAt = new Date(
    Math.min(expiryFromDays(REFRESH_TOKEN_DAYS).getTime(), Date.now() + absoluteLifetimeMs())
  );
  const refreshToken = await encryptJwt({ userId, t: 'refresh' }, `${REFRESH_TOKEN_DAYS}d`);
  const jti = uuid();

  // One active session per user: logging in elsewhere revokes the old one.
  const record = await prisma.$transaction(async (tx) => {
    await tx.session.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true, jti: null },
    });
    return tx.session.create({
      data: {
        userId,
        refreshToken,
        jti,
        expiresAt: refreshExpiresAt,
        revoked: false,
        ipAddress: meta?.ipAddress ?? undefined,
        userAgent: meta?.userAgent?.slice(0, 1000) ?? undefined,
      },
    });
  });

  const accessToken = await encryptJwt(
    {
      userId,
      sessionId: record.id,
      jti,
      passwordChangeRequired: user.passwordChangeRequired,
    },
    ACCESS_TOKEN_EXP
  );

  const store = await cookies();
  // The cookie deliberately outlives the token inside it, which expires in
  // ACCESS_TOKEN_MINUTES. What bounds access is the JWT's own `exp`, verified
  // on every request; the cookie is kept so the browser still presents the
  // spent token when it comes to renew, which is how a continuing session is
  // told apart from a refresh cookie replayed on its own.
  store.set(ACCESS_COOKIE, accessToken, { ...adminCookieBase, expires: refreshExpiresAt });
  store.set(REFRESH_COOKIE, refreshToken, { ...adminCookieBase, expires: refreshExpiresAt });

  return { accessToken, refreshToken, sessionId: record.id };
}

interface AccessPayload {
  userId: string;
  sessionId: string;
  jti?: string | null;
  passwordChangeRequired?: boolean;
}

/**
 * Resolves the current admin session.
 *
 * The two tokens have separate jobs and this is where that separation is
 * enforced. By default — for every guarded page, Server Component and API
 * route — a **valid access token is required**: the refresh cookie alone
 * authenticates nothing. Otherwise the access token is decorative, and anyone
 * who comes by a refresh token holds a credential that opens every endpoint
 * directly for as long as the session lives.
 *
 * `allowRefresh: true` is the one exception, and only `/api/admin/auth/session`
 * passes it. There the refresh cookie is exchanged for a fresh access token and
 * that new cookie is written, which is the whole of what a refresh token is
 * for. It is a Route Handler, so the write is legal there; from a Server
 * Component, where cookie mutation throws, the default never reaches it.
 *
 * The exchange deliberately does not rotate the refresh token. A browser fires
 * several guarded requests at once, each of which would race to rotate and
 * invalidate the others' cookie mid-flight. What bounds a refresh token here is
 * the idle and absolute limits above, which no amount of refreshing widens.
 */
export async function getAdminSession(options?: {
  allowRefresh?: boolean;
}): Promise<AccessPayload | null> {
  const allowRefresh = options?.allowRefresh === true;
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;

  // An access token that fails verification is not an expired one. It was
  // edited, forged, or signed with another key, and none of those are states a
  // session recovers from — they end it, exactly as an edited refresh token
  // does. Checking this before anything else is what stops the renewal path
  // below from quietly reissuing a good token to replace a tampered one.
  const checked = access ? await verifyJwt<AccessPayload>(access) : null;
  if (checked?.status === 'invalid') return null;

  if (checked?.status === 'valid') {
    const payload = checked.payload;
    if (payload?.userId && payload?.sessionId) {
      const record = await prisma.session.findUnique({ where: { id: payload.sessionId } });
      const valid =
        record &&
        !record.revoked &&
        record.expiresAt > new Date() &&
        record.userId === payload.userId;

      if (valid) {
        // The access token must carry the JTI currently bound to the session,
        // and the caller must hold the matching refresh cookie. Either check
        // failing means a token was swapped in from somewhere else.
        if (payload.jti && record.jti && payload.jti !== record.jti) return null;
        if (!refresh || refresh !== record.refreshToken) return null;

        const breach = sessionLifetimeBreach(record);
        if (breach) {
          await revokeSession(record.id, `${breach} limit exceeded`);
          return null;
        }

        await prisma.session.update({
          where: { id: record.id },
          data: { lastActivity: new Date() },
        });
        return payload;
      }
    }
  }

  // Past this point the caller holds no usable access token. Only the renewal
  // endpoint may go further; for everything else this is where a request that
  // carries nothing but a refresh cookie stops.
  if (!allowRefresh) return null;
  if (!refresh) return null;

  // A refresh token renews an access token; it is not one. A browser continuing
  // a session always still presents its access cookie — it outlives the token
  // inside it precisely so this check can tell the two cases apart. A request
  // carrying the refresh cookie *alone* is that token being replayed as a
  // credential in its own right, which is the thing being prevented here.
  //
  // Only an expired token gets this far: `valid` returned above, and `invalid`
  // was refused outright. So the claims read below carry a signature we issued,
  // and the binding check that follows is worth something.
  if (checked?.status !== 'expired') return null;

  const record = await prisma.session.findUnique({ where: { refreshToken: refresh } });
  if (!record || record.revoked || record.expiresAt < new Date()) return null;

  // And it must be the access token from this same session, so a token minted
  // for one session cannot be renewed with another session's refresh cookie.
  const presented = checked.payload;
  if (presented.sessionId !== record.id || presented.userId !== record.userId) return null;

  const breach = sessionLifetimeBreach(record);
  if (breach) {
    await revokeSession(record.id, `${breach} limit exceeded`);
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) return null;

  await prisma.session.update({
    where: { id: record.id },
    data: { lastActivity: new Date() },
  });

  // The refresh token and its expiry are left exactly as they are: renewing
  // extends nothing, so a session cannot outlive the cap set at sign-in.
  const payload: AccessPayload = {
    userId: record.userId,
    sessionId: record.id,
    jti: record.jti,
    passwordChangeRequired: user.passwordChangeRequired,
  };

  // Same reasoning as at sign-in: the cookie is carried for as long as the
  // session can live, the token inside it for fifteen minutes.
  store.set(ACCESS_COOKIE, await encryptJwt({ ...payload }, ACCESS_TOKEN_EXP), {
    ...adminCookieBase,
    expires: record.expiresAt,
  });

  return payload;
}

/** The session plus the authoritative role/permissions, always read fresh from the DB. */
export async function getCurrentUser(options?: {
  allowRefresh?: boolean;
}): Promise<SessionUser | null> {
  const session = await getAdminSession(options);
  if (!session?.userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { role: true },
  });
  if (!user || user.status !== 'ACTIVE') return null;

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    status: user.status,
    role: user.role.name,
    roleId: user.roleId,
    permissions: parsePermissions(user.role.permissions),
    passwordChangeRequired: user.passwordChangeRequired,
    providerId: user.providerId,
  };
}

export async function revokeAllUserSessions(userId: string) {
  await prisma.session.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true, jti: null },
  });
}

export async function deleteAdminSession() {
  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  const access = store.get(ACCESS_COOKIE)?.value;

  if (refresh) {
    const record = await prisma.session.findUnique({ where: { refreshToken: refresh } });
    if (record) {
      await prisma.session.update({
        where: { id: record.id },
        data: { revoked: true, jti: null },
      });
    }
  } else if (access) {
    const payload = await decryptJwt<AccessPayload>(access);
    if (payload?.sessionId) {
      await prisma.session
        .update({ where: { id: payload.sessionId }, data: { revoked: true, jti: null } })
        .catch(() => null);
    }
  }

  const expired = new Date(0);
  store.set(ACCESS_COOKIE, '', { ...adminCookieBase, expires: expired });
  store.set(REFRESH_COOKIE, '', { ...adminCookieBase, expires: expired });
}

// --------------------------------------
// BORROWER SESSIONS (super-app token)
// --------------------------------------

export interface BorrowerSessionPayload {
  borrowerId: string;
  phone: string;
  superAppToken: string;
  /**
   * Session was created through the authorization bypass. Carried in the signed
   * cookie so it cannot be forged, and checked wherever real money would move.
   */
  isTest?: boolean;
  /**
   * Identifies this sign-in. Anything that should happen once per login rather
   * than once per page — a welcome message — compares against it server-side, which
   * a webview's storage quirks cannot influence.
   */
  sid?: string;
  /**
   * When this sign-in happened, in epoch milliseconds.
   *
   * Carried through every renewal so the absolute cap is measured from the
   * original `/connect`, not from the last request. Without it, a session that
   * kept sliding would never end.
   */
  start?: number;
}

/**
 * The borrower session's absolute cap.
 *
 * Shorter than the previous day-long window: the token inside is the customer's
 * super-app credential, and the webview can always re-exchange it silently, so
 * there is no reason to hold one for longer than a banking session.
 */
export function borrowerSessionHours(): number {
  const configured = Number(process.env.BORROWER_SESSION_HOURS);
  const hours = Number.isFinite(configured) && configured > 0 ? configured : 8;
  return clamp(hours, 1, 24);
}

/**
 * How long a borrower session may sit unused.
 *
 * The admin session has had both an idle and an absolute limit for a while; the
 * borrower cookie only had the absolute one, so a phone left on a bench kept a
 * usable session for the full eight hours. This is the other half of that pair.
 */
export function borrowerIdleMs(): number {
  const configured = Number(process.env.BORROWER_IDLE_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 30;
  return clamp(minutes, 5, 240) * 60_000;
}

/**
 * When the cookie issued now must stop working: the idle window from this
 * moment, or the absolute cap from sign-in, whichever comes first.
 *
 * Both limits live in the token's own `exp`, which means the signature check in
 * `decryptJwt` enforces them — there is no separate timestamp a caller could
 * forget to compare, and nothing client-side that could be wound back.
 */
function borrowerExpiry(startedAt: number): Date {
  const idleDeadline = Date.now() + borrowerIdleMs();
  const absoluteDeadline = startedAt + borrowerSessionHours() * 60 * 60_000;
  return new Date(Math.min(idleDeadline, absoluteDeadline));
}

/** Signs a borrower cookie that expires at `expires`, and sets it. */
async function writeBorrowerCookie(payload: BorrowerSessionPayload, expires: Date) {
  const seconds = Math.max(1, Math.round((expires.getTime() - Date.now()) / 1000));
  const jwt = await encryptJwt({ ...payload }, `${seconds}s`);
  const store = await cookies();
  store.set(BORROWER_COOKIE, jwt, { ...borrowerCookieBase, expires });
  return jwt;
}

export async function createBorrowerSession(payload: BorrowerSessionPayload) {
  const start = Date.now();
  return writeBorrowerCookie({ sid: uuid(), ...payload, start }, borrowerExpiry(start));
}

/**
 * The current borrower, and a nudge to the idle clock.
 *
 * Reading the session is also the moment we know the borrower is active, so the
 * cookie is re-issued with a fresh idle window — capped, always, at the
 * absolute deadline carried in `start`. The write is best-effort: this is
 * called from Server Components as well as route handlers, and cookie mutation
 * throws in the former. A page view that cannot slide the window still reads a
 * valid session, and the API call the shell fires alongside it slides one.
 */
export async function getBorrowerSession(): Promise<BorrowerSessionPayload | null> {
  const store = await cookies();
  const raw = store.get(BORROWER_COOKIE)?.value;
  if (!raw) return null;
  const payload = await decryptJwt<BorrowerSessionPayload & { iat?: number }>(raw);
  if (!payload?.borrowerId) return null;
  // A real session always carries the super-app token; a test session has none.
  if (!payload.isTest && !payload.superAppToken) return null;
  // The bypass mints a session with no credential behind it. Honouring one on a
  // deployment where the bypass has since been switched off would let a cookie
  // issued during testing keep working in production.
  if (payload.isTest && !isTestLoginEnabled()) return null;

  // Cookies issued before `start` existed fall back to the token's own issue
  // time, so an upgrade does not sign every borrower out mid-session.
  const startedAt = payload.start ?? (payload.iat ? payload.iat * 1000 : Date.now());
  const expiry = borrowerExpiry(startedAt);
  if (expiry.getTime() <= Date.now()) return null;

  const { iat: _iat, exp: _exp, ...session } = payload as typeof payload & { exp?: number };
  const current: BorrowerSessionPayload = { ...session, start: startedAt };

  // Re-signing on every single request would cost a signature per API call for
  // no gain; a minute of drift on a thirty-minute window changes nothing.
  const issuedAt = payload.iat ? payload.iat * 1000 : 0;
  if (Date.now() - issuedAt > 60_000) {
    await writeBorrowerCookie(current, expiry).catch(() => null);
  }

  return current;
}

export async function deleteBorrowerSession() {
  const store = await cookies();
  store.set(BORROWER_COOKIE, '', { ...borrowerCookieBase, expires: new Date(0) });
}
