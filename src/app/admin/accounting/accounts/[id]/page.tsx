import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { generalLedger } from '@/lib/reports';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, TextFilter } from '@/components/admin/filters';
import { Button } from '@/components/ui/button';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'General ledger' };

export default async function AccountLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const query = await searchParams;
  const account = await prisma.ledgerAccount.findUnique({ where: { id }, select: { providerId: true } });
  if (!account || (user.providerId && account.providerId !== user.providerId)) notFound();

  const to = parseIsoDay(query.to, today());
  const from = parseIsoDay(query.from, to - 30);
  const ledger = await generalLedger(id, from, to);
  if (!ledger) notFound();
  const currency = String((await getSettings())['platform.currency'] || 'ETB');

  return (
    <>
      <PageHeader
        title={`${ledger.account.code} ${ledger.account.name}`}
        breadcrumbs={[
          { label: 'Accounting', href: `/admin/accounting?providerId=${account.providerId}` },
          { label: ledger.account.name },
        ]}
        description={`${ledger.account.provider} · ${ledger.account.type}`}
      />
      <FilterBar>
        <TextFilter name="from" label="From" type="date" value={dayToIso(from)} />
        <TextFilter name="to" label="To" type="date" value={dayToIso(to)} />
        <FilterSubmit />
        <Button asChild variant="outline" size="sm" className="h-9">
          <a href={`/api/admin/accounting/export?kind=general-ledger&accountId=${id}&from=${dayToIso(from)}&to=${dayToIso(to)}`}>Export CSV</a>
        </Button>
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Date</th>
              <th className="px-4 py-2.5 font-semibold">Journal</th>
              <th className="px-4 py-2.5 font-semibold">Description</th>
              <th className="px-4 py-2.5 text-right font-semibold">Debit</th>
              <th className="px-4 py-2.5 text-right font-semibold">Credit</th>
              <th className="px-4 py-2.5 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr className="bg-secondary/30">
              <td className="px-4 py-2" colSpan={5}>
                Opening balance
              </td>
              <td className="num px-4 py-2 text-right">{moneyCents(ledger.openingBalance, currency)}</td>
            </tr>
            {ledger.rows.length === 0 && <EmptyRow colSpan={6} message="No postings in this range." />}
            {ledger.rows.map((r, i) => (
              <tr key={i}>
                <td className="px-4 py-2">{r.date}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {r.journalNo}
                  <span className="ml-1 rounded bg-secondary px-1 text-[10px]">{r.type}</span>
                </td>
                <td className="px-4 py-2">{r.description}</td>
                <td className="num px-4 py-2 text-right">{r.debit ? moneyCents(r.debit) : ''}</td>
                <td className="num px-4 py-2 text-right">{r.credit ? moneyCents(r.credit) : ''}</td>
                <td className="num px-4 py-2 text-right">{moneyCents(r.balance)}</td>
              </tr>
            ))}
            <tr className="bg-secondary/40 font-semibold">
              <td className="px-4 py-2" colSpan={5}>
                Closing balance
              </td>
              <td className="num px-4 py-2 text-right">{moneyCents(ledger.closingBalance, currency)}</td>
            </tr>
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
