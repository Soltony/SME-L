import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { dateFromDay, dayFromDate, dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { toCents } from '@/lib/money';
import { REPAYMENT_CHANNELS } from '@/lib/types';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Repayments' };

export default async function RepaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; channel?: string; status?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const to = parseIsoDay(params.to, today());
  const from = parseIsoDay(params.from, to - 30);
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 50;
  const currency = String((await getSettings())['platform.currency'] || 'ETB');

  const where: Prisma.RepaymentWhereInput = {
    valueDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
    ...(user.providerId ? { loan: { providerId: user.providerId } } : {}),
    ...((REPAYMENT_CHANNELS as readonly string[]).includes(params.channel ?? '') ? { channel: params.channel } : {}),
    ...(['POSTED', 'REVERSED'].includes(params.status ?? '') ? { status: params.status } : {}),
  };

  const [repayments, total, sums] = await Promise.all([
    prisma.repayment.findMany({
      where,
      include: { loan: { select: { id: true, loanNumber: true, borrower: { select: { fullName: true, phoneNumber: true } } } } },
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.repayment.count({ where }),
    prisma.repayment.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { amount: true } }),
  ]);

  return (
    <>
      <PageHeader
        title="Repayments"
        description={`Posted receipts total ${moneyCents(toCents(sums._sum.amount), currency)} for ${dayToIso(from)} to ${dayToIso(to)}. Reversals are requested from the loan page.`}
      />
      <FilterBar>
        <TextFilter name="from" label="From" type="date" value={dayToIso(from)} />
        <TextFilter name="to" label="To" type="date" value={dayToIso(to)} />
        <SelectFilter name="channel" label="Channel" value={params.channel} options={REPAYMENT_CHANNELS.map((c) => ({ value: c, label: c }))} />
        <SelectFilter name="status" label="Status" value={params.status} options={[{ value: 'POSTED', label: 'Posted' }, { value: 'REVERSED', label: 'Reversed' }]} />
        <FilterSubmit />
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Receipt</th>
              <th className="px-4 py-2.5 font-semibold">Value date</th>
              <th className="px-4 py-2.5 font-semibold">Loan</th>
              <th className="px-4 py-2.5 font-semibold">Channel</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-2.5 text-right font-semibold">Principal</th>
              <th className="px-4 py-2.5 text-right font-semibold">Charges</th>
              <th className="px-4 py-2.5 text-right font-semibold">Overpaid</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {repayments.length === 0 && <EmptyRow colSpan={9} message="No repayments in this range." />}
            {repayments.map((r) => (
              <tr key={r.id} className="hover:bg-secondary/30">
                <td className="px-4 py-2.5 font-mono">{r.receiptNo}</td>
                <td className="px-4 py-2.5">{dayToIso(dayFromDate(r.valueDate))}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/admin/loans/${r.loan.id}`} className="font-mono text-primary hover:underline">
                    {r.loan.loanNumber}
                  </Link>
                  <p className="text-xs text-muted-foreground">{r.loan.borrower.fullName ?? r.loan.borrower.phoneNumber}</p>
                </td>
                <td className="px-4 py-2.5">
                  {r.channel}
                  {r.externalReference && <p className="text-xs text-muted-foreground">{r.externalReference}</p>}
                </td>
                <td className="num px-4 py-2.5 text-right font-medium">{moneyCents(toCents(r.amount))}</td>
                <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(r.principalPortion))}</td>
                <td className="num px-4 py-2.5 text-right">
                  {moneyCents(toCents(r.interestPortion) + toCents(r.feePortion) + toCents(r.penaltyPortion) + toCents(r.taxPortion))}
                </td>
                <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(r.excessPortion))}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/repayments" params={{ from: dayToIso(from), to: dayToIso(to), channel: params.channel, status: params.status }} />
      </TableCard>
    </>
  );
}
