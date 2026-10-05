import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { dateFromDay, dayFromDate, dayFromInstant, dayStart, dayToIso, parseIsoDay, today, type Day } from '@/lib/business-date';
import { toCents, type Cents } from '@/lib/money';
import { REPAYMENT_CHANNELS } from '@/lib/types';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Repayments' };

const LOAN = {
  select: {
    id: true,
    loanNumber: true,
    borrower: { select: { fullName: true, phoneNumber: true } },
    provider: { select: { name: true } },
  },
} as const;

/** One line of the list: a repayment that was posted, or a payment that failed before it could be. */
interface Row {
  id: string;
  at: Date;
  /** The bank's FT number: typed in for a manual receipt, sent by the gateway for a wallet one. */
  reference: string | null;
  receiptNo: string | null;
  valueDay: Day;
  loan: { id: string; loanNumber: string; borrower: { fullName: string | null; phoneNumber: string }; provider: { name: string } };
  channel: string;
  /** The account a wallet payment was collected into, as it was signed. Not recorded for other channels. */
  creditAccount: string | null;
  amount: Cents;
  portions: { principal: Cents; interest: Cents; fee: Cents; penalty: Cents; tax: Cents; excess: Cents } | null;
  status: string;
  note: string | null;
}

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

  const status = ['POSTED', 'FAILED', 'REVERSED'].includes(params.status ?? '') ? params.status : undefined;
  const channel = (REPAYMENT_CHANNELS as readonly string[]).includes(params.channel ?? '') ? params.channel : undefined;
  const scope = user.providerId ? { loan: { providerId: user.providerId } } : {};

  const where: Prisma.RepaymentWhereInput = {
    valueDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
    ...scope,
    ...(channel ? { channel } : {}),
    ...(status && status !== 'FAILED' ? { status } : {}),
  };
  // A payment that failed never becomes a repayment. It stays behind as the
  // wallet attempt the gateway refused, or that nobody confirmed in time.
  const failedWhere: Prisma.PaymentIntentWhereInput = {
    status: { in: ['FAILED', 'EXPIRED'] },
    createdAt: { gte: dayStart(from), lt: dayStart(to + 1) },
    ...scope,
    ...(channel ? { channel } : {}),
  };
  const showRepayments = status !== 'FAILED';
  const showFailed = !status || status === 'FAILED';

  // Two tables share one list, so each is read up to the end of this page and
  // the merged rows are cut down to the page afterwards.
  const upTo = page * pageSize;
  const [repayments, repaymentCount, failed, failedCount, sums] = await Promise.all([
    showRepayments
      ? prisma.repayment.findMany({
          where,
          include: { loan: LOAN, paymentIntent: { select: { gatewayReference: true, collectionAccountNo: true } } },
          orderBy: { receivedAt: 'desc' },
          take: upTo,
        })
      : [],
    showRepayments ? prisma.repayment.count({ where }) : 0,
    showFailed
      ? prisma.paymentIntent.findMany({ where: failedWhere, include: { loan: LOAN }, orderBy: { createdAt: 'desc' }, take: upTo })
      : [],
    showFailed ? prisma.paymentIntent.count({ where: failedWhere }) : 0,
    prisma.repayment.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { amount: true } }),
  ]);

  const rows: Row[] = [
    ...repayments.map((r) => ({
      id: r.id,
      at: r.receivedAt,
      reference: r.externalReference ?? r.paymentIntent?.gatewayReference ?? null,
      receiptNo: r.receiptNo,
      valueDay: dayFromDate(r.valueDate),
      loan: r.loan,
      channel: r.channel,
      creditAccount: r.paymentIntent?.collectionAccountNo ?? null,
      amount: toCents(r.amount),
      portions: {
        principal: toCents(r.principalPortion),
        interest: toCents(r.interestPortion),
        fee: toCents(r.feePortion),
        penalty: toCents(r.penaltyPortion),
        tax: toCents(r.taxPortion),
        excess: toCents(r.excessPortion),
      },
      status: r.status,
      note: null,
    })),
    ...failed.map((p) => ({
      id: p.id,
      at: p.createdAt,
      reference: p.gatewayReference,
      receiptNo: null,
      valueDay: dayFromInstant(p.createdAt),
      loan: p.loan,
      channel: p.channel,
      creditAccount: p.collectionAccountNo,
      amount: toCents(p.amount),
      portions: null,
      status: 'FAILED',
      note: p.status === 'EXPIRED' ? 'Not confirmed by the wallet in time' : p.failureReason,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice((page - 1) * pageSize, upTo);

  return (
    <>
      <PageHeader
        title="Repayments"
        description={`Successful repayments total ${moneyCents(toCents(sums._sum.amount), currency)} for ${dayToIso(from)} to ${dayToIso(to)}. Reversals are requested from the loan page.`}
      />
      <FilterBar>
        <TextFilter name="from" label="From" type="date" value={dayToIso(from)} />
        <TextFilter name="to" label="To" type="date" value={dayToIso(to)} />
        <SelectFilter name="channel" label="Channel" value={params.channel} options={REPAYMENT_CHANNELS.map((c) => ({ value: c, label: c }))} />
        <SelectFilter
          name="status"
          label="Status"
          value={params.status}
          options={[
            { value: 'POSTED', label: 'Success' },
            { value: 'FAILED', label: 'Failed' },
            { value: 'REVERSED', label: 'Reversed' },
          ]}
        />
        <FilterSubmit />
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[1500px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Receipt</th>
              <th className="px-4 py-2.5 font-semibold">Value date</th>
              <th className="px-4 py-2.5 font-semibold">Loan</th>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 font-semibold">Channel</th>
              <th className="px-4 py-2.5 font-semibold">Credit account</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-2.5 text-right font-semibold">Principal</th>
              <th className="px-4 py-2.5 text-right font-semibold">Interest</th>
              <th className="px-4 py-2.5 text-right font-semibold">Fee</th>
              <th className="px-4 py-2.5 text-right font-semibold">Penalty</th>
              <th className="px-4 py-2.5 text-right font-semibold">Tax</th>
              <th className="px-4 py-2.5 text-right font-semibold">Overpaid</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && <EmptyRow colSpan={14} message="No repayments in this range." />}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-secondary/30">
                <td className="px-4 py-2.5">
                  <span className="font-mono">{r.reference ?? r.receiptNo ?? '—'}</span>
                  {r.reference && r.receiptNo && <p className="text-xs text-muted-foreground">{r.receiptNo}</p>}
                </td>
                <td className="px-4 py-2.5">{dayToIso(r.valueDay)}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/admin/loans/${r.loan.id}`} className="font-mono text-primary hover:underline">
                    {r.loan.loanNumber}
                  </Link>
                  {!user.providerId && <p className="text-xs text-muted-foreground">{r.loan.provider.name}</p>}
                </td>
                <td className="px-4 py-2.5">
                  {r.loan.borrower.fullName ?? '—'}
                  <p className="font-mono text-xs text-muted-foreground">{r.loan.borrower.phoneNumber}</p>
                </td>
                <td className="px-4 py-2.5">{r.channel}</td>
                <td className="px-4 py-2.5 font-mono">{r.creditAccount ?? '—'}</td>
                <td className="num px-4 py-2.5 text-right font-medium">{moneyCents(r.amount)}</td>
                {(['principal', 'interest', 'fee', 'penalty', 'tax', 'excess'] as const).map((part) => (
                  <td key={part} className="num px-4 py-2.5 text-right">
                    {r.portions ? moneyCents(r.portions[part]) : '—'}
                  </td>
                ))}
                <td className="px-4 py-2.5">
                  <StatusBadge status={r.status} />
                  {r.note && (
                    <p className="max-w-[200px] truncate text-xs text-muted-foreground" title={r.note}>
                      {r.note}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          page={page}
          pageSize={pageSize}
          total={repaymentCount + failedCount}
          basePath="/admin/repayments"
          params={{ from: dayToIso(from), to: dayToIso(to), channel: params.channel, status: params.status }}
        />
      </TableCard>
    </>
  );
}
