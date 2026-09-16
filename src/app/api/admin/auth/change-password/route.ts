import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getCurrentUser, revokeAllUserSessions, deleteAdminSession } from '@/lib/session';
import { hashPassword, validatePassword, verifyPassword } from '@/lib/admin-users';
import { createAuditLog } from '@/lib/audit-log';
import { clientMeta, jsonError, readJsonBody, tooManyRequests } from '@/lib/api';
import { clearRateLimit, consumeRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser({ allowRefresh: false });
  if (!user) return jsonError('Not authenticated', 401);

  // Authenticated, but this endpoint verifies the current password — which
  // makes it an oracle for guessing it from a session that was hijacked rather
  // than signed in to. Keyed on the account, since that is what is at risk.
  const limit = consumeRateLimit('passwordChange', `account:${user.id}`);
  if (!limit.ok) {
    return tooManyRequests(limit.retryAfterSeconds, 'Too many attempts. Please wait and retry.');
  }

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  const confirmPassword = String(body?.confirmPassword || '');

  if (!currentPassword || !newPassword) {
    return jsonError('Current and new passwords are required.', 400);
  }
  if (newPassword !== confirmPassword) {
    return jsonError('The new passwords do not match.', 400);
  }
  if (newPassword === currentPassword) {
    return jsonError('The new password must be different from the current one.', 400);
  }

  const policy = validatePassword(newPassword);
  if (!policy.ok) return jsonError(policy.error, 400);

  const record = await prisma.user.findUnique({ where: { id: user.id } });
  if (!record) return jsonError('User not found', 404);

  const valid = await verifyPassword(currentPassword, record.password);
  if (!valid) {
    await createAuditLog({
      actorId: user.id,
      actorName: user.fullName,
      action: 'PASSWORD_CHANGE_FAILED',
      ...clientMeta(req),
    });
    return jsonError('Your current password is incorrect.', 401);
  }

  clearRateLimit('passwordChange', `account:${user.id}`);

  await prisma.user.update({
    where: { id: user.id },
    data: { password: await hashPassword(newPassword), passwordChangeRequired: false },
  });

  // Every session is invalidated, this client's included — a new password means
  // signing in again with it, so a leaked token cannot outlive the change.
  await revokeAllUserSessions(user.id);
  await deleteAdminSession();

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'PASSWORD_CHANGED',
    ...clientMeta(req),
  });

  return NextResponse.json({ ok: true, redirectTo: '/admin/login?passwordChanged=1' });
}
