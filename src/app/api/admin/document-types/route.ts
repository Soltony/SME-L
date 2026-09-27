import { NextRequest, NextResponse } from 'next/server';
import { assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * Requests a new document type. A bank document is asked of every borrower, so
 * only bank staff may request one; a provider document only for a provider the
 * requester may act for.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('document-types', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  if (body.scope === 'GLOBAL' && user.providerId) {
    return jsonError("Bank documents are asked of every borrower, so only bank staff set them up.", 403);
  }

  return handle(async () => {
    if (body.scope !== 'GLOBAL') assertProviderAccess(user, String(body.providerId ?? ''), 'Provider');
    const change = await requestChange({
      kind: 'DocumentType.CREATE',
      payload: body,
      summary: `Create ${body.scope === 'GLOBAL' ? 'bank' : 'provider'} document type ${String(body.name ?? '')}`,
      user,
    });
    return { ok: true, message: 'Document type submitted for approval.', changeId: change.id };
  });
}
