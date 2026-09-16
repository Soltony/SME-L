import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { generateTempPassword, hashPassword, isValidEmail } from '@/lib/admin-users';
import { maskPhone, parseEthiopianMobile } from '@/lib/format';
import { deliverTempPassword } from '@/lib/temp-password';

export const dynamic = 'force-dynamic';

const PHONE_ERROR = 'Enter a valid Ethiopian mobile number, such as 0912345678.';

export async function GET() {
  const guard = await requirePermission('users', 'read');
  if (isGuardFailure(guard)) return guard.response;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: { role: { select: { id: true, name: true } } },
  });

  return NextResponse.json({
    users: users.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      status: user.status,
      role: user.role.name,
      roleId: user.roleId,
      providerId: user.providerId,
      passwordChangeRequired: user.passwordChangeRequired,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lockedUntil: user.lockedUntil?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission('users', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const { user: actor } = guard;

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const fullName = String(body.fullName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phoneNumber = parseEthiopianMobile(String(body.phoneNumber || ''));
  const roleId = String(body.roleId || '');

  // `field` names the input the message belongs to, so the form can show the
  // complaint where it was made rather than as a detached toast.
  if (!fullName) return jsonError('Full name is required.', 400, { field: 'fullName' });
  if (!isValidEmail(email)) {
    return jsonError('Enter a valid email address.', 400, { field: 'email' });
  }
  // An exact format, not a minimum length: the old check took anything from
  // nine digits upward and stripped whatever was not a digit, so an entry
  // carrying text was stored as a number that can never be dialled — and this
  // account is reachable only by SMS.
  if (!phoneNumber) {
    return jsonError(PHONE_ERROR, 400, { field: 'phoneNumber' });
  }
  if (!roleId) return jsonError('A role must be assigned.', 400, { field: 'roleId' });

  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return jsonError('The selected role does not exist.', 404, { field: 'roleId' });

  // Staff tied to one provider only ever see that provider's loans, books and queue.
  const providerId = body.providerId ? String(body.providerId) : null;
  if (providerId) {
    if (role.name === 'Super Admin') {
      return jsonError('A Super Admin sees every provider and cannot be limited to one.', 400, { field: 'providerId' });
    }
    const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { id: true } });
    if (!provider) return jsonError('The selected provider does not exist.', 404, { field: 'providerId' });
  }

  const clash = await prisma.user.findFirst({
    where: { OR: [{ email }, { phoneNumber }] },
    select: { email: true, phoneNumber: true },
  });
  if (clash) {
    return clash.email === email
      ? jsonError('An account with this email already exists.', 409, { field: 'email' })
      : jsonError('An account with this phone number already exists.', 409, {
          field: 'phoneNumber',
        });
  }

  // The account starts with a one-time password that must be replaced at first
  // sign-in, so no admin ever knows another admin's standing password.
  const tempPassword = generateTempPassword();

  const created = await prisma.user.create({
    data: {
      fullName,
      email,
      phoneNumber,
      password: await hashPassword(tempPassword),
      passwordChangeRequired: true,
      status: 'ACTIVE',
      roleId,
      providerId,
    },
  });

  // Straight to the account holder. The response below carries only whether
  // it arrived, so the operator who created the account never reads it.
  const delivery = await deliverTempPassword({
    fullName,
    phoneNumber,
    password: tempPassword,
    purpose: 'CREATED',
  });

  await createAuditLog({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'USER_CREATED',
    entity: 'User',
    entityId: created.id,
    details: {
      fullName,
      email,
      phoneNumber,
      role: role.name,
      providerId,
      passwordDelivered: delivery.delivered,
      deliveryError: delivery.error ?? null,
    },
  });

  return NextResponse.json(
    {
      id: created.id,
      // Whether it arrived, and nothing else: the reason a send failed is for
      // the server log and the audit row, not for the operator's screen.
      passwordDelivery: {
        delivered: delivery.delivered,
        recipient: maskPhone(phoneNumber),
      },
    },
    { status: 201 }
  );
}
