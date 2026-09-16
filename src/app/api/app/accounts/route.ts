import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, requireBorrower, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { CoreBankingError, fetchCustomerAccounts } from '@/lib/integrations/core-banking';
import { createAuditLog } from '@/lib/audit-log';

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
 * Refreshes the borrower's verified accounts from core banking, looked up by
 * the phone number in their session — never by a number the client sends.
 */
export async function POST() {
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
    const numbers = result.accounts.map((a) => a.accountNumber);
    await prisma.$transaction([
      prisma.borrowerAccount.deleteMany({
        where: { borrowerId: ctx.borrower.id, accountNumber: { notIn: numbers.length ? numbers : ['__none__'] } },
      }),
      ...result.accounts.map((a) =>
        prisma.borrowerAccount.upsert({
          where: { borrowerId_accountNumber: { borrowerId: ctx.borrower.id, accountNumber: a.accountNumber } },
          create: {
            borrowerId: ctx.borrower.id,
            accountNumber: a.accountNumber,
            accountName: a.accountName,
            source: result.simulated ? 'SIMULATED' : 'CBS',
          },
          update: { accountName: a.accountName, verifiedAt: new Date(), source: result.simulated ? 'SIMULATED' : 'CBS' },
        })
      ),
    ]);
    await createAuditLog({
      actorId: ctx.borrower.phoneNumber,
      actorType: 'BORROWER',
      action: 'BORROWER_ACCOUNTS_REFRESHED',
      entity: 'Borrower',
      entityId: ctx.borrower.id,
      details: { count: numbers.length, simulated: result.simulated },
    });
    return { accounts: result.accounts.map((a) => ({ accountNumber: a.accountNumber, accountName: a.accountName })) };
  });
}
