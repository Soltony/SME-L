import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { createAdminSession } from '@/lib/session';
import { hashPassword, verifyPassword } from '@/lib/admin-users';
import { createAuditLog } from '@/lib/audit-log';
import { getSettings } from '@/lib/settings';
import { clientMeta, jsonError, readJsonBody, tooManyRequests } from '@/lib/api';
import { parsePermissions, firstAllowedPath } from '@/lib/permissions';
import { ADMIN_ROUTES, moduleKeyFor } from '@/lib/route-permissions';
import { clearRateLimit, consumeRateLimit } from '@/lib/rate-limit';
import { addressKey } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

// Deliberately identical for "no such user" and "wrong password" so the login
// form cannot be used to enumerate valid accounts.
const GENERIC_FAILURE = 'Invalid email or password.';

/**
 * A real bcrypt hash compared against when the email is unknown, so an unknown
 * account takes as long to refuse as a wrong password. Without it the response
 * time alone tells an attacker which emails have accounts.
 */
let dummyHash: Promise<string> | null = null;
function timingEqualizer() {
  dummyHash ??= hashPassword('timing-equalizer-not-a-real-password');
  return dummyHash;
}

export async function POST(req: NextRequest) {
  const meta = clientMeta(req);
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (!email || !password) return jsonError('Email and password are required.', 400);

  // Two windows, because they stop different attacks. The per-account window is
  // the companion to the lockout below; the per-address one is what stops a
  // single caller spraying one password across many accounts, which never
  // trips any individual account's counter.
  const perAccount = consumeRateLimit('adminLogin', `account:${email}`);
  const perAddress = consumeRateLimit('adminLogin', `addr:${addressKey(req.headers)}`, {
    limit: 30,
    windowMs: 5 * 60_000,
  });

  if (!perAccount.ok || !perAddress.ok) {
    const retryAfter = Math.max(perAccount.retryAfterSeconds, perAddress.retryAfterSeconds);
    await createAuditLog({
      actorId: email,
      actorType: 'ADMIN',
      action: 'LOGIN_RATE_LIMITED',
      details: { scope: !perAccount.ok ? 'account' : 'address', retryAfter },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return tooManyRequests(retryAfter, 'Too many sign-in attempts. Please wait and try again.');
  }

  const settings = await getSettings();
  const maxAttempts = Number(settings['security.maxFailedLogins']) || 5;
  const lockoutMinutes = Number(settings['security.lockoutMinutes']) || 15;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { role: true },
  });

  if (!user) {
    await verifyPassword(password, await timingEqualizer());
    await createAuditLog({
      actorId: email,
      actorType: 'ADMIN',
      action: 'LOGIN_FAILED',
      details: { reason: 'Unknown email' },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return jsonError(GENERIC_FAILURE, 401);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    return jsonError(`Account locked. Try again in ${minutes} minute(s).`, 423);
  }

  if (user.status !== 'ACTIVE') {
    await createAuditLog({
      actorId: user.id,
      actorName: user.fullName,
      action: 'LOGIN_BLOCKED',
      details: { reason: `Account status is ${user.status}` },
      ipAddress: meta.ipAddress,
    });
    return jsonError('This account is not active. Contact a system administrator.', 403);
  }

  const valid = await verifyPassword(password, user.password);

  if (!valid) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= maxAttempts;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + lockoutMinutes * 60_000) : null,
      },
    });

    await createAuditLog({
      actorId: user.id,
      actorName: user.fullName,
      action: shouldLock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      details: { attempt: failedCount, maxAttempts },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    if (shouldLock) {
      return jsonError(
        `Too many failed attempts. This account is locked for ${lockoutMinutes} minutes.`,
        423
      );
    }
    return jsonError(GENERIC_FAILURE, 401);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  // A genuine sign-in clears the window, so an operator who fumbled their
  // password a few times is not left throttled once they get it right.
  clearRateLimit('adminLogin', `account:${email}`);

  await createAdminSession(user.id, meta);

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'LOGIN_SUCCESS',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  const permissions = parsePermissions(user.role.permissions);
  const landing = user.passwordChangeRequired
    ? '/admin/change-password'
    : firstAllowedPath(
        permissions,
        user.role.name,
        ADMIN_ROUTES.map((r) => ({ path: r.path, moduleKey: moduleKeyFor(r.label) }))
      );

  return NextResponse.json({
    ok: true,
    passwordChangeRequired: user.passwordChangeRequired,
    redirectTo: landing,
  });
}
