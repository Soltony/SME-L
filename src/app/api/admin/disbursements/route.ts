import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';
import { processDisbursementQueue } from '@/lib/lending/disbursement';
import { createAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = await requirePermission('disbursements', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const action = String(body.action || '');

  return handle(async () => {
    if (action === 'process-queue') {
      if (user.providerId) throw new ApiError(403, 'Only platform staff can run the disbursement queue.');
      const result = await processDisbursementQueue();
      await createAuditLog({
        actorId: user.id,
        actorName: user.fullName,
        action: 'DISBURSEMENT_QUEUE_RUN',
        details: result,
      });
      return {
        ok: true,
        message: result.paused
          ? 'Disbursements are switched off in settings; nothing was sent.'
          : `Processed ${result.attempted} queued disbursement(s).`,
        result,
      };
    }

    if (action === 'resolve') {
      const attemptId = String(body.attemptId || '');
      const attempt = await prisma.disbursementAttempt.findUnique({
        where: { id: attemptId },
        include: { loan: { select: { loanNumber: true, providerId: true } } },
      });
      if (!attempt || (user.providerId && attempt.loan.providerId !== user.providerId)) {
        throw new ApiError(404, 'Disbursement not found.');
      }
      if (!['UNKNOWN', 'SENT'].includes(attempt.status)) {
        throw new ApiError(409, 'Only a disbursement with an unknown outcome needs resolving.');
      }
      const resolution = String(body.resolution || '');
      const change = await requestChange({
        kind: 'Disbursement.RESOLVE',
        entityId: attempt.id,
        payload: { resolution, reference: body.reference || undefined, note: body.note },
        summary: `${resolution === 'CONFIRM' ? 'Confirm' : 'Fail'} disbursement of ${attempt.loan.loanNumber}`,
        user,
      });
      return { ok: true, message: 'Resolution requested. It is applied once approved.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
