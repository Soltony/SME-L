import { NextRequest, NextResponse } from 'next/server';
import { handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { reviewBorrowerDocument } from '@/lib/lending/borrower-documents';

export const dynamic = 'force-dynamic';

/**
 * A reviewer's decision on a borrower document. The borrower is the maker and
 * the reviewer the checker, as for applications. Bank documents are decided by
 * bank staff only, a provider's documents by that provider's staff only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('documents', 'approve');
  if (isGuardFailure(guard)) return guard.response;

  const body = await readJsonBody<{ action?: string; note?: string; expiresOn?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const action = String(body.action || '');
  if (action !== 'approve' && action !== 'reject') return jsonError('Unknown action.', 400);

  return handle(async () => {
    await reviewBorrowerDocument(
      id,
      action === 'approve' ? 'APPROVE' : 'REJECT',
      {
        note: body.note ? String(body.note).slice(0, 1000) : null,
        expiresOn: body.expiresOn ? String(body.expiresOn) : null,
      },
      guard.user
    );
    return { ok: true, message: action === 'approve' ? 'Document approved.' : 'Document rejected. The borrower has been told.' };
  });
}
