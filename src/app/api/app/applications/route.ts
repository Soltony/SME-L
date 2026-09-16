import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, jsonError, readJsonBody, requireBorrower, tooManyRequests } from '@/lib/api';
import { centsToNumber, parseUserAmount, toCents } from '@/lib/money';
import { consumeRateLimit } from '@/lib/rate-limit';
import { submitApplication } from '@/lib/lending/applications';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => {
    const applications = await prisma.loanApplication.findMany({
      where: { borrowerId: ctx.borrower.id },
      include: { product: { select: { name: true } }, provider: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      applications: applications.map((a) => ({
        id: a.id,
        applicationNo: a.applicationNo,
        productName: a.product.name,
        providerName: a.provider.name,
        requestedAmount: centsToNumber(toCents(a.requestedAmount)),
        approvedAmount: a.approvedAmount ? centsToNumber(toCents(a.approvedAmount)) : null,
        status: a.status,
        loanId: a.loanId,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });
}

export async function POST(req: NextRequest) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('loanApplication', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, 'Too many applications. Please wait a few minutes.');

  const body = await readJsonBody<{
    productId?: string;
    amount?: unknown;
    accountNumber?: string;
    acceptedTermsId?: string | null;
  }>(req);
  if (body instanceof NextResponse) return body;

  const amount = parseUserAmount(body.amount);
  if (amount === null) return jsonError('Enter a valid amount.', 400, { field: 'amount' });
  if (!body.productId) return jsonError('Choose a product.', 400, { field: 'productId' });
  if (!body.accountNumber) return jsonError('Choose the account to receive the loan.', 400, { field: 'accountNumber' });

  return handle(() =>
    submitApplication({
      borrower: ctx.borrower,
      productId: String(body.productId),
      amount,
      accountNumber: String(body.accountNumber),
      acceptedTermsId: body.acceptedTermsId ? String(body.acceptedTermsId) : null,
    })
  );
}
