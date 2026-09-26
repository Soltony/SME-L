import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { buildLoanView } from '@/lib/lending/loan-view';
import { borrowerPhoneNumbers } from '@/lib/lending/borrower-identity';
import { visibleToBorrower } from '@/lib/lending/eligibility-lists';
import { centsToNumber, toCents } from '@/lib/money';
import { HomeClient, type HomeLoan, type PendingApplication } from '@/components/borrower/home-client';
import type { RailProvider } from '@/components/borrower/provider-rail';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Home' };

/**
 * The borrower's home screen.
 *
 * Everything that does not depend on scoring is rendered here — the lenders,
 * the loans being carried, the applications waiting — so the screen is useful
 * before any credit check has run. Limits and per-product decisions are the
 * slow part (they read provisioned data and, for some lenders, the borrower's
 * bank statement), so they are fetched per lender from the client once the
 * shell is on screen.
 */
export default async function BorrowerHome({ searchParams }: { searchParams: Promise<{ lender?: string }> }) {
  const { borrower } = await requireBorrowerPage();
  const { lender } = await searchParams;
  const numbers = await borrowerPhoneNumbers(prisma, borrower);

  const [settings, providers, loanRows, applications, accounts] = await Promise.all([
    getSettings(),
    // A lender with nothing this borrower may see is not shown at all.
    prisma.loanProvider.findMany({
      where: { status: 'ACTIVE', products: { some: { status: 'ACTIVE', ...visibleToBorrower(numbers) } } },
      select: { id: true, name: true, colorHex: true, icon: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.loan.findMany({
      where: { borrowerId: borrower.id, status: { in: ['ACTIVE', 'PENDING_DISBURSEMENT'] } },
      include: { installments: true, product: { select: { name: true } }, provider: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.loanApplication.findMany({
      where: { borrowerId: borrower.id, status: 'SUBMITTED' },
      select: { id: true, providerId: true, requestedAmount: true, product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.borrowerAccount.findMany({
      where: { borrowerId: borrower.id },
      select: { accountNumber: true, accountName: true },
      orderBy: { verifiedAt: 'desc' },
    }),
  ]);

  const loans: HomeLoan[] = loanRows.map((row) => ({ ...buildLoanView(row), providerId: row.providerId }));
  const rail: RailProvider[] = providers.map((provider) => ({
    ...provider,
    openLoans: loans.filter((loan) => loan.providerId === provider.id).length,
  }));
  const pending: PendingApplication[] = applications.map((application) => ({
    id: application.id,
    productName: application.product.name,
    providerId: application.providerId,
    amount: centsToNumber(toCents(application.requestedAmount)),
  }));

  return (
    <HomeClient
      providers={rail}
      loans={loans}
      pending={pending}
      accounts={accounts}
      holderName={borrower.fullName ?? borrower.phoneNumber}
      currency={String(settings['platform.currency'] || 'ETB')}
      isNpl={borrower.isNpl}
      supportPhone={String(settings['platform.supportPhone'] || '')}
      initialProviderId={rail.some((p) => p.id === lender) ? (lender as string) : null}
    />
  );
}
