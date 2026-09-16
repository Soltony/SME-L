import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { buildLoanView } from '@/lib/lending/loan-view';
import { StatusBadge } from '@/components/admin/status-badge';
import { money } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My loans' };

export default async function MyLoansPage() {
  const { borrower } = await requireBorrowerPage();
  const [loans, applications] = await Promise.all([
    prisma.loan.findMany({
      where: { borrowerId: borrower.id },
      include: { installments: true, product: { select: { name: true } }, provider: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.loanApplication.findMany({
      where: { borrowerId: borrower.id, status: { in: ['SUBMITTED', 'REJECTED', 'CANCELLED'] } },
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  const views = loans.map((l) => buildLoanView(l));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">My loans</h1>
      {views.length === 0 && applications.length === 0 && (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          You have no loans yet.{' '}
          <Link href="/home" className="text-primary underline">
            See what you can borrow
          </Link>
        </p>
      )}
      <ul className="space-y-2">
        {views.map((v) => (
          <li key={v.id}>
            <Link href={`/loans/${v.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{v.productName}</span>
                <span className="block text-xs text-muted-foreground">
                  {v.loanNumber} · {money(v.principal, v.currency)}
                </span>
                <StatusBadge status={v.status} className="mt-1" />
              </span>
              <span className="flex shrink-0 items-center gap-1 text-right">
                <span>
                  <span className="num block font-semibold">{money(v.outstanding.total)}</span>
                  <span className="block text-[11px] text-muted-foreground">{v.status === 'ACTIVE' ? 'owed today' : ''}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {applications.length > 0 && (
        <>
          <h2 className="pt-2 text-sm font-semibold text-muted-foreground">Applications</h2>
          <ul className="space-y-2">
            {applications.map((a) => (
              <li key={a.id}>
                <Link href={`/applications/${a.id}`} className="flex items-center justify-between rounded-xl border border-border bg-card p-3 text-sm">
                  <span>
                    {a.product.name}
                    <span className="block text-xs text-muted-foreground">{a.applicationNo}</span>
                  </span>
                  <StatusBadge status={a.status} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
