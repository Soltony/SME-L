import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import { requestChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * Loan actions that move money or remove it from the books. None is applied
 * here: each becomes a request that a second person must approve.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('loans', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const action = String(body.action || '');

  return handle(async () => {
    const loan = await prisma.loan.findUnique({
      where: { id },
      select: { id: true, loanNumber: true, providerId: true, status: true, creditBalance: true },
    });
    if (!loan || (user.providerId && loan.providerId !== user.providerId)) throw new ApiError(404, 'Loan not found.');

    if (action === 'write-off') {
      if (!hasPermission(user, 'loans', 'update')) return jsonError('You do not have permission to request a write-off.', 403);
      if (loan.status !== 'ACTIVE') throw new ApiError(409, 'Only an active loan can be written off.');
      const change = await requestChange({
        kind: 'Loan.WRITE_OFF',
        entityId: loan.id,
        payload: { reason: body.reason },
        summary: `Write off ${loan.loanNumber}`,
        user,
      });
      return { ok: true, message: 'Write-off requested. It takes effect once approved.', changeId: change.id };
    }

    if (action === 'refund') {
      if (!hasPermission(user, 'loans', 'update')) return jsonError('You do not have permission to request a refund.', 403);
      const change = await requestChange({
        kind: 'Loan.REFUND',
        entityId: loan.id,
        payload: { amount: body.amount, reference: body.reference },
        summary: `Refund overpayment of ${String(body.amount)} on ${loan.loanNumber}`,
        user,
      });
      return { ok: true, message: 'Refund requested.', changeId: change.id };
    }

    if (action === 'manual-repayment') {
      if (!hasPermission(user, 'repayments', 'create')) {
        return jsonError('You do not have permission to record repayments.', 403);
      }
      if (loan.status !== 'ACTIVE') throw new ApiError(409, 'Only an active loan can take a repayment.');
      const change = await requestChange({
        kind: 'Repayment.MANUAL',
        entityId: loan.id,
        payload: { amount: body.amount, reference: body.reference, note: body.note || undefined },
        summary: `Manual repayment of ${String(body.amount)} on ${loan.loanNumber} (${String(body.reference)})`,
        user,
      });
      return { ok: true, message: 'Repayment recorded for approval. It posts once approved.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
