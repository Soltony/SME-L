import { NextRequest, NextResponse } from 'next/server';
import { ApiError, handle, isGuardFailure, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = await requirePermission('providers', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    if (guard.user.providerId) throw new ApiError(403, 'Provider staff cannot create other providers.');
    const change = await requestChange({
      kind: 'Provider.CREATE',
      payload: body,
      summary: `Create provider ${String(body.name ?? '')}`,
      user: guard.user,
    });
    return { ok: true, message: 'Provider creation requested. It is created once approved.', changeId: change.id };
  });
}
