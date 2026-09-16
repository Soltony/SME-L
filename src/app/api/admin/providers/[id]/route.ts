import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';
import { providerFormValues } from '@/lib/lending/catalog';

export const dynamic = 'force-dynamic';

/** Update the provider, or publish a new version of its terms. Both need approval. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('providers', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  return handle(async () => {
    assertProviderAccess(guard.user, id, 'Provider');
    const provider = await prisma.loanProvider.findUnique({ where: { id } });
    if (!provider) throw new ApiError(404, 'Provider not found.');
    const action = String(body.action || 'update');

    if (action === 'update') {
      const { action: _ignored, ...values } = body;
      const change = await requestChange({
        kind: 'Provider.UPDATE',
        entityId: id,
        payload: values,
        previousData: providerFormValues(provider),
        summary: `Update provider ${provider.name}`,
        user: guard.user,
      });
      return { ok: true, message: 'Change requested. It applies once approved.', changeId: change.id };
    }

    if (action === 'publish-terms') {
      const change = await requestChange({
        kind: 'Terms.PUBLISH',
        entityId: id,
        payload: { providerId: id, content: body.content },
        summary: `Publish new terms & conditions for ${provider.name}`,
        user: guard.user,
      });
      return { ok: true, message: 'New terms submitted for approval.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
