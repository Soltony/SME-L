import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';
import { taxPayload, taxRuleSchema } from '@/lib/lending/catalog';

export const dynamic = 'force-dynamic';

/** Requests a change to a tax rule. Loans already issued keep the tax they were given. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('taxes', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  if (user.providerId) return jsonError('Taxes apply to every provider, so only platform staff can change them.', 403);

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  return handle(async () => {
    const tax = await prisma.taxRule.findUnique({ where: { id } });
    if (!tax) throw new ApiError(404, 'Tax rule not found.');
    const change = await requestChange({
      kind: 'TaxRule.UPDATE',
      entityId: id,
      payload: taxPayload(body),
      previousData: taxRuleSchema.parse({ ...tax, ratePercent: tax.ratePercent.toString() }),
      summary: `Update tax rule ${tax.name}`,
      user,
    });
    return { ok: true, message: 'Tax change submitted for approval. Existing loans keep their original tax.', changeId: change.id };
  });
}
