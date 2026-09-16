import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { sanitizePermissions, parsePermissions, SUPER_ADMIN_ROLE } from '@/lib/permissions';
import type { Permissions } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('access-control', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) return jsonError('Role not found', 404);

  // Super Admin bypasses permission checks entirely, so editing its matrix
  // would be misleading — it always has everything.
  if (role.name === SUPER_ADMIN_ROLE) {
    return jsonError('The Super Admin role always has full access and cannot be edited.', 409);
  }

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return jsonError('Role name cannot be empty.', 400);
    if (name !== role.name) {
      const clash = await prisma.role.findUnique({ where: { name } });
      if (clash) return jsonError('A role with this name already exists.', 409);
      data.name = name;
    }
  }

  if (body.description !== undefined) data.description = String(body.description) || null;

  let permissionDiff: { before: unknown; after: unknown } | undefined;
  if (body.permissions !== undefined) {
    const next = sanitizePermissions((body.permissions ?? {}) as Permissions);
    permissionDiff = { before: parsePermissions(role.permissions), after: next };
    data.permissions = JSON.stringify(next);
  }

  if (Object.keys(data).length === 0) return jsonError('Nothing to update.', 400);

  await prisma.role.update({ where: { id }, data });

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'ROLE_UPDATED',
    entity: 'Role',
    entityId: id,
    details: { name: role.name, changed: Object.keys(data), permissions: permissionDiff },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePermission('access-control', 'delete');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) return jsonError('Role not found', 404);
  if (role.isSystem || role.name === SUPER_ADMIN_ROLE) {
    return jsonError('System roles cannot be deleted.', 409);
  }
  if (role._count.users > 0) {
    return jsonError(
      `${role._count.users} user(s) still hold this role. Reassign them first.`,
      409
    );
  }

  await prisma.role.delete({ where: { id } });

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'ROLE_DELETED',
    entity: 'Role',
    entityId: id,
    details: { name: role.name },
  });

  return NextResponse.json({ ok: true });
}
