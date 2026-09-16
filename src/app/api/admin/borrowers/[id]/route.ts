import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * Blocks or unblocks a borrower. A block stops new sign-ins and applications;
 * it never touches loans already on the books, which keep accruing and can
 * still be repaid.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('borrowers', 'update');
  if (isGuardFailure(guard)) return guard.response;
  if (guard.user.providerId) {
    return jsonError('Blocking applies across every provider, so only platform staff can do it.', 403);
  }
  const body = await readJsonBody<{ status?: string; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  const status = String(body.status || '').toUpperCase();
  if (!['ACTIVE', 'BLOCKED'].includes(status)) return jsonError('Status must be ACTIVE or BLOCKED.', 400);
  const reason = String(body.reason || '').trim();
  if (status === 'BLOCKED' && reason.length < 5) return jsonError('Give a reason for blocking.', 400, { field: 'reason' });

  return handle(async () => {
    const borrower = await prisma.borrower.findUnique({ where: { id } });
    if (!borrower) throw new ApiError(404, 'Borrower not found.');
    await prisma.borrower.update({ where: { id }, data: { status } });
    await createAuditLog({
      actorId: guard.user.id,
      actorName: guard.user.fullName,
      action: status === 'BLOCKED' ? 'BORROWER_BLOCKED' : 'BORROWER_UNBLOCKED',
      entity: 'Borrower',
      entityId: id,
      details: { reason, phone: borrower.phoneNumber },
    });
    return { ok: true, message: status === 'BLOCKED' ? 'Borrower blocked.' : 'Borrower unblocked.' };
  });
}
