import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { generateTempPassword, hashPassword, isValidEmail } from '@/lib/admin-users';
import { revokeAllUserSessions } from '@/lib/session';
import { SUPER_ADMIN_ROLE } from '@/lib/permissions';
import { maskPhone, parseEthiopianMobile } from '@/lib/format';
import { deliverTempPassword } from '@/lib/temp-password';

export const dynamic = 'force-dynamic';

const PHONE_ERROR = 'Enter a valid Ethiopian mobile number, such as 0912345678.';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('users', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user: actor } = guard;

  const { id } = await params;
  const target = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!target) return jsonError('User not found', 404);

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const action = String(body?.action || 'update');

  if (action === 'reset-password') {
    // Self-reset is a lockout: the revoke below kills the actor's own session,
    // and the one-time password only ever goes to the account holder by SMS, so
    // the actor would be locked out of a password they never get to read.
    if (id === actor.id) {
      return jsonError('Use Change password to update your own password.', 409);
    }

    const tempPassword = generateTempPassword();
    await prisma.user.update({
      where: { id },
      data: {
        password: await hashPassword(tempPassword),
        passwordChangeRequired: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // Any live session keeps working otherwise, defeating the reset.
    await revokeAllUserSessions(id);

    const delivery = await deliverTempPassword({
      fullName: target.fullName,
      phoneNumber: target.phoneNumber,
      password: tempPassword,
      purpose: 'RESET',
    });

    await createAuditLog({
      actorId: actor.id,
      actorName: actor.fullName,
      action: 'USER_PASSWORD_RESET',
      entity: 'User',
      entityId: id,
      details: {
        email: target.email,
        passwordDelivered: delivery.delivered,
        deliveryError: delivery.error ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      passwordDelivery: {
        delivered: delivery.delivered,
        recipient: maskPhone(target.phoneNumber),
      },
    });
  }

  if (action === 'unlock') {
    await prisma.user.update({
      where: { id },
      data: { lockedUntil: null, failedLoginCount: 0 },
    });
    await createAuditLog({
      actorId: actor.id,
      actorName: actor.fullName,
      action: 'USER_UNLOCKED',
      entity: 'User',
      entityId: id,
      details: { email: target.email },
    });
    return NextResponse.json({ ok: true });
  }

  const data: Record<string, unknown> = {};

  if (body.fullName !== undefined) {
    const fullName = String(body.fullName).trim();
    if (!fullName) return jsonError('Full name cannot be empty.', 400, { field: 'fullName' });
    data.fullName = fullName;
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!isValidEmail(email)) {
      return jsonError('Enter a valid email address.', 400, { field: 'email' });
    }
    if (email !== target.email) {
      const clash = await prisma.user.findUnique({ where: { email } });
      if (clash) {
        return jsonError('An account with this email already exists.', 409, { field: 'email' });
      }
      data.email = email;
    }
  }

  if (body.phoneNumber !== undefined) {
    const phoneNumber = parseEthiopianMobile(String(body.phoneNumber));
    if (!phoneNumber) {
      return jsonError(PHONE_ERROR, 400, { field: 'phoneNumber' });
    }
    if (phoneNumber !== target.phoneNumber) {
      const clash = await prisma.user.findUnique({ where: { phoneNumber } });
      if (clash) {
        return jsonError('An account with this phone number already exists.', 409, {
          field: 'phoneNumber',
        });
      }
      data.phoneNumber = phoneNumber;
    }
  }

  if (body.roleId !== undefined && body.roleId !== target.roleId) {
    const role = await prisma.role.findUnique({ where: { id: String(body.roleId) } });
    if (!role) return jsonError('The selected role does not exist.', 404, { field: 'roleId' });

    // Removing the last Super Admin would lock everyone out of Access Control.
    if (target.role.name === SUPER_ADMIN_ROLE && role.name !== SUPER_ADMIN_ROLE) {
      const remaining = await prisma.user.count({
        where: { role: { name: SUPER_ADMIN_ROLE }, status: 'ACTIVE', NOT: { id } },
      });
      if (remaining === 0) {
        return jsonError('This is the last active Super Admin — assign another one first.', 409);
      }
    }
    data.roleId = role.id;
  }

  if (body.providerId !== undefined) {
    const providerId = body.providerId ? String(body.providerId) : null;
    if (providerId) {
      const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { id: true } });
      if (!provider) return jsonError('The selected provider does not exist.', 404, { field: 'providerId' });
      const roleName = data.roleId
        ? (await prisma.role.findUnique({ where: { id: String(data.roleId) } }))?.name
        : target.role.name;
      if (roleName === SUPER_ADMIN_ROLE) {
        return jsonError('A Super Admin sees every provider and cannot be limited to one.', 400, { field: 'providerId' });
      }
    }
    if (providerId !== target.providerId) {
      data.providerId = providerId;
      // Narrowing what someone may see takes effect now, not at their next sign-in.
      await revokeAllUserSessions(id);
    }
  }

  if (body.status !== undefined) {
    const status = String(body.status).toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(status)) {
      return jsonError('Status must be ACTIVE, SUSPENDED or DISABLED.', 400);
    }
    // Checked before the self rule below: when both apply — the last Super
    // Admin disabling themselves — this is the one that says how to get
    // unstuck, and it is the constraint that holds for every actor rather than
    // only for this one.
    if (status !== 'ACTIVE' && target.role.name === SUPER_ADMIN_ROLE) {
      const remaining = await prisma.user.count({
        where: { role: { name: SUPER_ADMIN_ROLE }, status: 'ACTIVE', NOT: { id } },
      });
      if (remaining === 0) {
        return jsonError('This is the last active Super Admin and cannot be deactivated.', 409);
      }
    }
    if (status !== 'ACTIVE' && id === actor.id) {
      return jsonError('You cannot deactivate your own account.', 409);
    }
    data.status = status;
    if (status !== 'ACTIVE') await revokeAllUserSessions(id);
  }

  if (Object.keys(data).length === 0) return jsonError('Nothing to update.', 400);

  await prisma.user.update({ where: { id }, data });

  await createAuditLog({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'USER_UPDATED',
    entity: 'User',
    entityId: id,
    details: { email: target.email, changed: Object.keys(data) },
  });

  return NextResponse.json({ ok: true });
}
