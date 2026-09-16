import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { csvResponse } from '@/lib/csv-response';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 20_000;

export async function GET(req: NextRequest) {
  const guard = await requirePermission('audit-logs', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const action = url.searchParams.get('action');

  const logs = await prisma.auditLog.findMany({
    where: {
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(action ? { action: { contains: action } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  });

  await createAuditLog({
    actorId: user.id,
    actorName: user.fullName,
    action: 'AUDIT_LOG_EXPORTED',
    entity: 'AuditLog',
    details: { rows: logs.length, from, to, action, truncated: logs.length === MAX_ROWS },
  });

  return csvResponse(
    `audit-log_${new Date().toISOString().slice(0, 10)}.csv`,
    ['Timestamp', 'Actor id', 'Actor name', 'Actor type', 'Action', 'Entity', 'Entity id', 'IP address', 'Details'],
    logs.map((l) => [l.createdAt.toISOString(), l.actorId, l.actorName ?? '', l.actorType, l.action, l.entity ?? '', l.entityId ?? '', l.ipAddress ?? '', l.details ?? ''])
  );
}
