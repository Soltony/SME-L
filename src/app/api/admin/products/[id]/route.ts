import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import { requestChange } from '@/lib/approvals';
import { productFormValues } from '@/lib/lending/catalog';
import { quoteForProduct } from '@/lib/lending/product-view';
import { parseUserAmount } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * Product changes: pricing and rules, tiers, and activation. All need approval.
 * Existing loans are never affected — each carries its own terms snapshot.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('products', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const action = String(body.action || '');

  return handle(async () => {
    const product = await prisma.loanProduct.findUnique({ where: { id } });
    if (!product) throw new ApiError(404, 'Product not found.');
    assertProviderAccess(user, product.providerId, 'Product');

    if (action === 'quote') {
      const amount = parseUserAmount(body.amount);
      if (amount === null) return jsonError('Enter a valid amount.', 400, { field: 'amount' });
      return quoteForProduct(id, amount, { activeOnly: false });
    }

    if (!hasPermission(user, 'products', 'update')) {
      return jsonError('You do not have permission to change products.', 403);
    }

    if (action === 'update') {
      const { action: _ignored, ...values } = body;
      if (values.providerId !== product.providerId) throw new ApiError(400, 'A product cannot move to another provider.');
      const change = await requestChange({
        kind: 'Product.UPDATE',
        entityId: id,
        payload: values,
        previousData: productFormValues(product),
        summary: `Update product ${product.name}`,
        user,
      });
      return { ok: true, message: 'Change requested. New loans use it once approved.', changeId: change.id };
    }

    if (action === 'status') {
      const status = String(body.status || '');
      const change = await requestChange({
        kind: 'Product.STATUS',
        entityId: id,
        payload: { status },
        previousData: { status: product.status },
        summary: `${status === 'ACTIVE' ? 'Activate' : 'Deactivate'} product ${product.name}`,
        user,
      });
      return { ok: true, message: 'Status change requested.', changeId: change.id };
    }

    if (action === 'tiers') {
      const existing = await prisma.loanAmountTier.findMany({ where: { productId: id }, orderBy: { minScore: 'asc' } });
      const change = await requestChange({
        kind: 'Product.TIERS',
        entityId: id,
        payload: { tiers: body.tiers },
        previousData: {
          tiers: existing.map((t) => ({ minScore: t.minScore, maxScore: t.maxScore, maxAmount: t.maxAmount.toString() })),
        },
        summary: `Replace loan amount tiers on ${product.name}`,
        user,
      });
      return { ok: true, message: 'Tier change requested.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
