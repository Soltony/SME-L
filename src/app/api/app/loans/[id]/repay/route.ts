import { NextRequest, NextResponse } from 'next/server';
import { handle, isBorrowerFailure, jsonError, readJsonBody, requireBorrower, tooManyRequests } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { consumeRateLimit } from '@/lib/rate-limit';
import { startWalletRepayment } from '@/lib/lending/payments';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('paymentInitiation', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonBody<{ amount?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const amount = parseUserAmount(body.amount);
  if (amount === null) return jsonError('Enter a valid amount.', 400, { field: 'amount' });

  const { id } = await params;
  return handle(() =>
    startWalletRepayment({
      borrower: ctx.borrower,
      superAppToken: ctx.session.superAppToken,
      isTest: Boolean(ctx.session.isTest),
      loanId: id,
      amount,
    })
  );
}
