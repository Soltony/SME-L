import Link from 'next/link';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { OPEN_LOAN_STATUSES } from '@/lib/types';
import { BorrowerNav } from '@/components/borrower/borrower-nav';
import { LogoMark } from '@/components/icons';

export const dynamic = 'force-dynamic';

/** Initials for the avatar, from a name or — failing that — a phone number. */
function initials(name: string | null, phone: string) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return phone.slice(-2);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export default async function BorrowerLayout({ children }: { children: React.ReactNode }) {
  const { session, borrower } = await requireBorrowerPage();
  const [settings, openLoans] = await Promise.all([
    getSettings(),
    prisma.loan.count({ where: { borrowerId: borrower.id, status: { in: OPEN_LOAN_STATUSES } } }),
  ]);
  const brand = String(settings['platform.name'] || 'SME Lending');
  const logo = String(settings['platform.logo'] || '') || null;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-background">
      {session.isTest && (
        <div className="bg-warning px-4 py-1.5 text-center text-xs font-semibold text-warning-foreground">
          Test session — repayments are simulated and recorded as TEST
        </div>
      )}

      {/*
       * The app bar carries the platform's identity in ink and gold and nothing
       * else, so that the lender's own colour further down the screen is the
       * only bright thing on it: the borrower reads the coloured card as "this
       * lender", not as decoration.
       */}
      <header className="ink sticky top-0 z-30 border-b border-primary/25">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <Link href="/home" className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10">
              <LogoMark src={logo} className="h-6 w-6" />
            </span>
            <span className="truncate font-bold tracking-tight">{brand}</span>
          </Link>
          <Link
            href="/profile"
            aria-label="Your profile"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
          >
            {initials(borrower.fullName, borrower.phoneNumber)}
          </Link>
        </div>
      </header>

      <main className="flex-1 px-4 pb-28 pt-4">{children}</main>
      <BorrowerNav openLoans={openLoans} />
    </div>
  );
}
