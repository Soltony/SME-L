import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/** Requests the reversal of a posted repayment. Applied only after approval. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('repayments', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const body = await readJsonBody<{ reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  return handle(async () => {
    const repayment = await prisma.repayment.findUnique({
      where: { id },
      include: { loan: { select: { loanNumber: true, providerId: true } } },
    });
    if (!repayment || (guard.user.providerId && repayment.loan.providerId !== guard.user.providerId)) {
      throw new ApiError(404, 'Repayment not found.');
    }
    if (repayment.status !== 'POSTED') throw new ApiError(409, 'This repayment has already been reversed.');
    const change = await requestChange({
      kind: 'Repayment.REVERSE',
      entityId: repayment.id,
      payload: { reason: body.reason },
      summary: `Reverse ${repayment.receiptNo} (${repayment.amount.toString()}) on ${repayment.loan.loanNumber}`,
      user: guard.user,
    });
    return { ok: true, message: 'Reversal requested. It is applied once approved.', changeId: change.id };
  });
}
