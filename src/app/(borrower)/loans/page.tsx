import Link from 'next/link';
import { ChevronRight, Inbox } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { buildLoanView } from '@/lib/lending/loan-view';
import { OPEN_LOAN_STATUSES } from '@/lib/types';
import { centsToNumber, toCents } from '@/lib/money';
import { alpha } from '@/lib/brand';
import { StatusBadge } from '@/components/admin/status-badge';
import { ProviderIcon } from '@/components/provider-icon';
import { money } from '@/components/money';
import { LoanCard } from '@/components/borrower/loan-card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My loans' };

/**
 * Every loan the borrower has had, newest first, split by what they can still
 * do about it: the ones they are carrying come with a Repay button, the ones
 * that are finished are a one-line record. A closed loan is kept visible
 * because it is the borrower's own proof of having repaid.
 */
export default async function MyLoansPage() {
  const { borrower } = await requireBorrowerPage();
  const [settings, loanRows, applications] = await Promise.all([
    getSettings(),
    prisma.loan.findMany({
      where: { borrowerId: borrower.id },
      include: {
        installments: true,
        product: { select: { name: true } },
        provider: { select: { name: true, colorHex: true, icon: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.loanApplication.findMany({
      where: { borrowerId: borrower.id, status: { in: ['SUBMITTED', 'REJECTED', 'CANCELLED'] } },
      include: { product: { select: { name: true } }, provider: { select: { name: true, colorHex: true, icon: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  const currency = String(settings['platform.currency'] || 'ETB');

  const loans = loanRows.map((row) => ({ view: buildLoanView(row), provider: row.provider }));
  const open = loans.filter((l) => (OPEN_LOAN_STATUSES as string[]).includes(l.view.status));
  const closed = loans.filter((l) => !(OPEN_LOAN_STATUSES as string[]).includes(l.view.status));
  const owed = open.reduce((sum, l) => sum + l.view.outstanding.total, 0);
  const borrowed = loans.reduce((sum, l) => sum + l.view.principal, 0);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">My loans</h1>

      <section className="ink grid grid-cols-3 gap-2 rounded-2xl p-4 text-center">
        <div>
          <p className="text-[11px] text-[hsl(var(--ink-muted))]">Owed today</p>
          <p className="num mt-0.5 font-bold">{money(owed)}</p>
        </div>
        <div className="border-x border-white/10">
          <p className="text-[11px] text-[hsl(var(--ink-muted))]">Borrowed in all</p>
          <p className="num mt-0.5 font-bold">{money(borrowed)}</p>
        </div>
        <div>
          <p className="text-[11px] text-[hsl(var(--ink-muted))]">Loans</p>
          <p className="num mt-0.5 font-bold">{loans.length}</p>
        </div>
      </section>
      {/* The currency once, under the figures, so three of them fit a phone. */}
      <p className="-mt-3 text-center text-[11px] text-muted-foreground">All amounts in {currency}.</p>

      {loans.length === 0 && applications.length === 0 && (
        <p className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          <Inbox className="mx-auto mb-2 h-8 w-8 opacity-40" />
          You have no loans yet.{' '}
          <Link href="/home" className="font-medium text-primary underline">
            See what you can borrow
          </Link>
        </p>
      )}

      {open.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Carrying now</h2>
          {open.map(({ view, provider }) => (
            <LoanCard key={view.id} loan={view} colorHex={provider.colorHex} />
          ))}
        </section>
      )}

      {applications.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Applications</h2>
          <ul className="space-y-2">
            {applications.map((application) => (
              <li key={application.id}>
                <Link
                  href={`/applications/${application.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border"
                      style={{
                        backgroundColor: alpha(application.provider.colorHex, 0.12),
                        borderColor: alpha(application.provider.colorHex, 0.3),
                      }}
                    >
                      <ProviderIcon icon={application.provider.icon} color={application.provider.colorHex} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{application.product.name}</span>
                      <span className="num block text-xs text-muted-foreground">
                        {money(centsToNumber(toCents(application.requestedAmount)), currency)} · {application.applicationNo}
                      </span>
                    </span>
                  </span>
                  <StatusBadge status={application.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Finished</h2>
          <ul className="space-y-2">
            {closed.map(({ view, provider }) => (
              <li key={view.id}>
                <Link
                  href={`/loans/${view.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border"
                      style={{ backgroundColor: alpha(provider.colorHex, 0.12), borderColor: alpha(provider.colorHex, 0.3) }}
                    >
                      <ProviderIcon icon={provider.icon} color={provider.colorHex} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{view.productName}</span>
                      <span className="num block text-xs text-muted-foreground">
                        {money(view.principal, view.currency)} · {view.loanNumber}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <StatusBadge status={view.status} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
