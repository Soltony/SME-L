import { NextRequest, NextResponse } from 'next/server';
import { handle, isBorrowerFailure, jsonError, readJsonBody, requireBorrower } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { quoteForProduct } from '@/lib/lending/product-view';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const body = await readJsonBody<{ amount?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const amount = parseUserAmount(body.amount);
  if (amount === null) return jsonError('Enter a valid amount.', 400, { field: 'amount' });
  const { id } = await params;
  return handle(() => quoteForProduct(id, amount, { activeOnly: true }));
}
