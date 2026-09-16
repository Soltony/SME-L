import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { sanitizePermissions } from '@/lib/permissions';
import type { Permissions } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requirePermission('access-control', 'read');
  if (isGuardFailure(guard)) return guard.response;

  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true } } },
  });

  return NextResponse.json({ roles });
}

export async function POST(req: NextRequest) {
  const guard = await requirePermission('access-control', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const name = String(body.name || '').trim();
  if (!name) return jsonError('Role name is required.', 400);

  const clash = await prisma.role.findUnique({ where: { name } });
  if (clash) return jsonError('A role with this name already exists.', 409);

  const permissions = sanitizePermissions((body.permissions || {}) as Permissions);

  const role = await prisma.role.create({
    data: {
      name,
      description: body.description ? String(body.description) : undefined,
      permissions: JSON.stringify(permissions),
    },
  });

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'ROLE_CREATED',
    entity: 'Role',
    entityId: role.id,
    details: { name, permissions },
  });

  return NextResponse.json({ id: role.id }, { status: 201 });
}
