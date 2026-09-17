import { NextRequest, NextResponse } from 'next/server';
import { handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';
import { taxPayload } from '@/lib/lending/catalog';

export const dynamic = 'force-dynamic';

/** Requests a new tax rule. It applies to new loans once approved. */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('taxes', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  if (user.providerId) return jsonError('Taxes apply to every provider, so only platform staff can change them.', 403);

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    const change = await requestChange({
      kind: 'TaxRule.CREATE',
      payload: taxPayload(body),
      summary: `Create tax rule ${String(body.name ?? '')}`,
      user,
    });
    return { ok: true, message: 'Tax rule submitted for approval. New loans use it once approved.', changeId: change.id };
  });
}
