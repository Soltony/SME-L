import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { OPEN_LOAN_STATUSES } from '@/lib/types';
import { BorrowerNav } from '@/components/borrower/borrower-nav';

export const dynamic = 'force-dynamic';

export default async function BorrowerLayout({ children }: { children: React.ReactNode }) {
  const { session, borrower } = await requireBorrowerPage();
  const openLoans = await prisma.loan.count({
    where: { borrowerId: borrower.id, status: { in: OPEN_LOAN_STATUSES } },
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-background">
      {session.isTest && (
        <div className="bg-warning px-4 py-1.5 text-center text-xs font-semibold text-warning-foreground">
          Test session — repayments are simulated and recorded as TEST
        </div>
      )}

      {/*
       * No app bar: the bottom nav already reaches every screen, and on a phone
       * the space is worth more to the lender's card and products than to a
       * platform logo the borrower has already seen.
       */}
      <main className="flex-1 px-4 pb-28 pt-4">{children}</main>
      <BorrowerNav openLoans={openLoans} />
    </div>
  );
}
