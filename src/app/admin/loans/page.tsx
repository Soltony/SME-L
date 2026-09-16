import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { toCents } from '@/lib/money';
import { dayFromDate, formatDay } from '@/lib/business-date';
import { LOAN_STATUSES } from '@/lib/types';
import { normalizePhone } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge, statusLabel } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { moneyCents } from '@/components/money';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Loans' };

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; providerId?: string; q?: string; overdue?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');

  const where: Prisma.LoanWhereInput = {
    ...(user.providerId ? { providerId: user.providerId } : params.providerId ? { providerId: params.providerId } : {}),
    ...(params.status && (LOAN_STATUSES as readonly string[]).includes(params.status) ? { status: params.status } : {}),
    ...(params.overdue === '1' ? { daysPastDue: { gt: 0 }, status: 'ACTIVE' } : {}),
  };
  const q = params.q?.trim();
  if (q) {
    where.OR = [
      { loanNumber: { contains: q } },
      { borrower: { phoneNumber: { contains: normalizePhone(q) || q } } },
      { borrower: { fullName: { contains: q } } },
    ];
  }

  const [loans, total, providers] = await Promise.all([
    prisma.loan.findMany({
      where,
      include: {
        borrower: { select: { phoneNumber: true, fullName: true } },
        product: { select: { name: true } },
        provider: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.loan.count({ where }),
    user.providerId ? [] : prisma.loanProvider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <>
      <PageHeader
        title="Loans"
        description="Balances are as of each loan's last accrual; open a loan to see today's figures."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/admin/reports/export?report=loans${params.providerId ? `&providerId=${params.providerId}` : ''}`}>Export loan book</a>
          </Button>
        }
      />
      <FilterBar>
        <TextFilter name="q" label="Search" value={params.q} placeholder="Loan no., phone or name" />
        <SelectFilter name="status" label="Status" value={params.status} options={LOAN_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))} />
        {!user.providerId && (
          <SelectFilter name="providerId" label="Provider" value={params.providerId} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        <SelectFilter name="overdue" label="Arrears" value={params.overdue} allLabel="Any" options={[{ value: '1', label: 'Overdue only' }]} />
        <FilterSubmit />
      </FilterBar>

      <TableCard>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Loan</th>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 font-semibold">Product</th>
              <th className="px-4 py-2.5 text-right font-semibold">Principal</th>
              <th className="px-4 py-2.5 text-right font-semibold">Outstanding</th>
              <th className="px-4 py-2.5 font-semibold">Maturity</th>
              <th className="px-4 py-2.5 text-right font-semibold">DPD</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loans.length === 0 && <EmptyRow colSpan={8} message="No loans match." />}
            {loans.map((loan) => {
              const outstanding =
                toCents(loan.principalOutstanding) +
                toCents(loan.interestOutstanding) +
                toCents(loan.feeOutstanding) +
                toCents(loan.penaltyOutstanding) +
                toCents(loan.taxOutstanding);
              return (
                <tr key={loan.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/loans/${loan.id}`} className="font-mono font-medium text-primary hover:underline">
                      {loan.loanNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{loan.borrower.fullName ?? '—'}</p>
                    <p className="font-mono text-xs text-muted-foreground">{loan.borrower.phoneNumber}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <p>{loan.product.name}</p>
                    {!user.providerId && <p className="text-xs text-muted-foreground">{loan.provider.name}</p>}
                  </td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(loan.principalAmount), currency)}</td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(outstanding, currency)}</td>
                  <td className="px-4 py-2.5">{loan.maturityDate ? formatDay(dayFromDate(loan.maturityDate)) : '—'}</td>
                  <td className={`num px-4 py-2.5 text-right ${loan.daysPastDue > 0 ? 'font-semibold text-destructive' : ''}`}>{loan.daysPastDue}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={loan.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/loans" params={{ status: params.status, providerId: params.providerId, q: params.q, overdue: params.overdue }} />
      </TableCard>
    </>
  );
}
