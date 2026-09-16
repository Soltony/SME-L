import { NextRequest, NextResponse } from 'next/server';
import { handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { approveApplication, rejectApplication } from '@/lib/lending/applications';

export const dynamic = 'force-dynamic';

/**
 * A reviewer's decision on an application. The borrower is the maker here and
 * the reviewer the checker; approval re-evaluates eligibility as of now.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('applications', 'approve');
  if (isGuardFailure(guard)) return guard.response;

  const body = await readJsonBody<{ action?: string; amount?: unknown; note?: string; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const action = String(body.action || '');

  if (action === 'approve') {
    let amount: number | null = null;
    if (body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '') {
      amount = parseUserAmount(body.amount);
      if (amount === null) return jsonError('Enter a valid amount.', 400, { field: 'amount' });
    }
    return handle(async () => {
      const result = await approveApplication(
        id,
        { amount, note: body.note ? String(body.note).trim().slice(0, 2000) : null },
        guard.user
      );
      const message =
        result.disbursement === 'SUCCEEDED'
          ? 'Approved and disbursed.'
          : result.disbursement === 'FAILED'
            ? 'Approved, but core banking refused the transfer. The loan was closed with nothing owed.'
            : result.disbursement === 'QUEUED'
              ? 'Approved. Disbursements are switched off, so the loan is queued.'
              : 'Approved. The disbursement outcome is unknown and needs checking.';
      return { ok: true, message, ...result };
    });
  }

  if (action === 'reject') {
    const reason = String(body.reason || '').trim();
    if (reason.length < 5) return jsonError('Give the borrower a reason.', 400, { field: 'reason' });
    return handle(async () => {
      await rejectApplication(id, reason.slice(0, 2000), guard.user);
      return { ok: true, message: 'Application rejected.' };
    });
  }

  return jsonError('Unknown action.', 400);
}
