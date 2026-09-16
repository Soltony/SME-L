import { NextRequest, NextResponse } from 'next/server';
import { assertProviderAccess, handle, isGuardFailure, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = await requirePermission('products', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    assertProviderAccess(guard.user, String(body.providerId ?? ''), 'Provider');
    const change = await requestChange({
      kind: 'Product.CREATE',
      payload: body,
      summary: `Create product ${String(body.name ?? '')}`,
      user: guard.user,
    });
    return {
      ok: true,
      message: 'Product submitted for approval. It is created as a draft once approved.',
      changeId: change.id,
    };
  });
}
