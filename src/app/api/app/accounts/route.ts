import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, clientMeta, handle, isBorrowerFailure, requireBorrower, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { CoreBankingError, fetchCustomerAccounts } from '@/lib/integrations/core-banking';
import { applyAccountLookup } from '@/lib/lending/bank-accounts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => ({
    accounts: await prisma.borrowerAccount.findMany({
      where: { borrowerId: ctx.borrower.id },
      select: { accountNumber: true, accountName: true, source: true, verifiedAt: true },
      orderBy: { verifiedAt: 'desc' },
    }),
  }));
}

/**
 * Refreshes the borrower's verified accounts, and the name on them, from core
 * banking — looked up by the phone number in their session, never by a number
 * the client sends.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('accountLookup', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  return handle(async () => {
    let result;
    try {
      result = await fetchCustomerAccounts(ctx.borrower.phoneNumber);
    } catch (error) {
      console.error('[accounts] lookup failed', error);
      if (error instanceof CoreBankingError) throw new ApiError(502, 'We could not reach the bank to load your accounts. Please try again.');
      throw error;
    }
    const { fullName } = await applyAccountLookup(ctx.borrower, result, { reason: 'BORROWER_REFRESH', ...clientMeta(req) });
    return { fullName, accounts: result.accounts.map((a) => ({ accountNumber: a.accountNumber, accountName: a.accountName })) };
  });
}
