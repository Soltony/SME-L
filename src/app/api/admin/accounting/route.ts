import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import { requestChange } from '@/lib/approvals';
import { createAuditLog } from '@/lib/audit-log';
import { runAccrualBatch } from '@/lib/lending/loan-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const guard = await requirePermission('accounting', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const action = String(body.action || '');

  return handle(async () => {
    if (action === 'run-accruals') {
      if (!hasPermission(user, 'accounting', 'update') || user.providerId) {
        return jsonError('Only platform finance staff can run the accrual batch.', 403);
      }
      const result = await runAccrualBatch();
      await createAuditLog({
        actorId: user.id,
        actorName: user.fullName,
        action: 'ACCRUAL_BATCH_RUN',
        details: { ...result, errors: result.errors.slice(0, 20) },
      });
      return {
        ok: true,
        message: `Accrued ${result.processed} loan(s); ${result.posted} journal(s) posted${result.failed ? `, ${result.failed} failed` : ''}.`,
        result: { ...result, errors: result.errors.slice(0, 20) },
      };
    }

    if (!hasPermission(user, 'accounting', 'create')) {
      return jsonError('You do not have permission to request postings.', 403);
    }
    const providerId = String(body.providerId || '');
    assertProviderAccess(user, providerId, 'Provider');
    const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { name: true } });
    if (!provider) throw new ApiError(404, 'Provider not found.');

    if (action === 'capital') {
      const direction = String(body.direction || '');
      const change = await requestChange({
        kind: 'Capital.POST',
        entityId: providerId,
        payload: { direction, amount: body.amount, reference: body.reference, note: body.note || undefined },
        summary: `${direction === 'WITHDRAW' ? 'Withdraw' : 'Inject'} ${String(body.amount)} capital — ${provider.name}`,
        user,
      });
      return { ok: true, message: 'Capital movement requested. It posts once approved.', changeId: change.id };
    }

    if (action === 'tax-remittance') {
      const change = await requestChange({
        kind: 'TaxRemittance.POST',
        entityId: providerId,
        payload: { amount: body.amount, reference: body.reference },
        summary: `Remit ${String(body.amount)} tax — ${provider.name}`,
        user,
      });
      return { ok: true, message: 'Tax remittance requested. It posts once approved.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
