import { NextRequest, NextResponse } from 'next/server';
import { handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { decideChange, withdrawChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/** Approve, reject, or (for the maker) withdraw a pending change. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readJsonBody<{ decision?: string; comment?: string }>(req);
  if (body instanceof NextResponse) return body;
  const decision = String(body.decision || '').toUpperCase();
  const comment = body.comment ? String(body.comment).trim().slice(0, 2000) : null;
  const { id } = await params;

  if (decision === 'WITHDRAW') {
    const guard = await requirePermission('approvals', 'read');
    if (isGuardFailure(guard)) return guard.response;
    return handle(async () => {
      await withdrawChange(id, guard.user, comment);
      return { ok: true, message: 'Request withdrawn.' };
    });
  }

  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return jsonError('Decision must be APPROVED, REJECTED or WITHDRAW.', 400);
  }
  if (decision === 'REJECTED' && !comment) {
    return jsonError('Give a reason when rejecting a request.', 400, { field: 'comment' });
  }

  const guard = await requirePermission('approvals', 'approve');
  if (isGuardFailure(guard)) return guard.response;
  return handle(async () => {
    const outcome = await decideChange(id, decision, guard.user, comment);
    return { ok: true, message: outcome.message, result: outcome.result };
  });
}
