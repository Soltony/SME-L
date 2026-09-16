import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, requireBorrower, tooManyRequests } from '@/lib/api';
import { evaluateEligibilityNow } from '@/lib/lending/eligibility';
import { prepareCoreBankingForProduct } from '@/lib/lending/core-banking-profile';
import { centsToNumber } from '@/lib/money';
import { consumeRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('eligibility', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const { id } = await params;
  return handle(async () => {
    await prepareCoreBankingForProduct(ctx.borrower.id, id);
    const result = await evaluateEligibilityNow(ctx.borrower, id);
    const product = await prisma.loanProduct.findUnique({ where: { id }, select: { providerId: true } });
    const [terms, accepted, accounts] = await Promise.all([
      product
        ? prisma.termsVersion.findFirst({
            where: { providerId: product.providerId, isActive: true },
            orderBy: { version: 'desc' },
            select: { id: true, version: true, content: true },
          })
        : null,
      prisma.termsAcceptance.findMany({ where: { borrowerId: ctx.borrower.id }, select: { termsId: true } }),
      prisma.borrowerAccount.findMany({
        where: { borrowerId: ctx.borrower.id },
        select: { accountNumber: true, accountName: true },
        orderBy: { verifiedAt: 'desc' },
      }),
    ]);
    // The score breakdown is for staff; the borrower gets the decision and the limit.
    return {
      eligible: result.eligible,
      reason: result.reason,
      minAmount: centsToNumber(result.minAmount),
      maxAmount: centsToNumber(result.maxAmount),
      terms: terms ? { ...terms, alreadyAccepted: accepted.some((a) => a.termsId === terms.id) } : null,
      accounts,
    };
  });
}
