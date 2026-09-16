import Link from 'next/link';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { formatDateTime, maskAccount } from '@/lib/format';
import { agingReport, collectionsReport, disbursementsReport, incomeReport, portfolioReport } from '@/lib/reports';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports' };

const TABS = [
  { key: 'portfolio', label: 'Portfolio', ranged: false },
  { key: 'aging', label: 'Aging', ranged: false },
  { key: 'collections', label: 'Collections', ranged: true },
  { key: 'income', label: 'Income', ranged: true },
  { key: 'disbursements', label: 'Disbursements', ranged: true },
];

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cn('px-4 py-2.5 font-semibold', right && 'text-right')}>{children}</th>;
}
function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn('px-4 py-2', right && 'num text-right', className)}>{children}</td>;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; providerId?: string; from?: string; to?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const tab = TABS.find((t) => t.key === params.tab) ?? TABS[0];
  const providerId = user.providerId ?? (params.providerId || null);
  const to = parseIsoDay(params.to, today());
  const from = parseIsoDay(params.from, to - 30);
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const providers = user.providerId ? [] : await prisma.loanProvider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const query = new URLSearchParams({
    report: tab.key,
    ...(providerId ? { providerId } : {}),
    from: dayToIso(from),
    to: dayToIso(to),
  });
  const m = (cents: number) => moneyCents(cents);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Computed from the ledger and the loan book. Income is shown both as earned (accrual) and as collected (cash)."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/admin/reports/export?${query.toString()}`}>Export CSV</a>
          </Button>
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/reports?tab=${t.key}${providerId && !user.providerId ? `&providerId=${providerId}` : ''}`}
            className={cn('rounded-full border px-3 py-1 text-sm font-medium', t.key === tab.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <FilterBar>
        <input type="hidden" name="tab" value={tab.key} />
        {!user.providerId && (
          <SelectFilter name="providerId" label="Provider" value={providerId ?? undefined} allLabel="All providers" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        {tab.ranged && (
          <>
            <TextFilter name="from" label="From" type="date" value={dayToIso(from)} />
            <TextFilter name="to" label="To" type="date" value={dayToIso(to)} />
          </>
        )}
        <FilterSubmit />
      </FilterBar>

      {tab.key === 'portfolio' &&
        (async () => {
          const rows = await portfolioReport(providerId);
          return (
            <TableCard>
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <Th>Provider</Th>
                    <Th right>Active</Th>
                    <Th right>Principal</Th>
                    <Th right>Interest</Th>
                    <Th right>Fees</Th>
                    <Th right>Penalties</Th>
                    <Th right>Tax</Th>
                    <Th right>Total</Th>
                    <Th right>PAR 30+</Th>
                    <Th right>PAR 90+</Th>
                    <Th right>NPL</Th>
                    <Th>Accrued through</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && <EmptyRow colSpan={12} message="No providers." />}
                  {rows.map((r) => (
                    <tr key={r.providerId}>
                      <Td>{r.providerName}</Td>
                      <Td right>{r.activeLoans}</Td>
                      <Td right>{m(r.principal)}</Td>
                      <Td right>{m(r.interest)}</Td>
                      <Td right>{m(r.fee)}</Td>
                      <Td right>{m(r.penalty)}</Td>
                      <Td right>{m(r.tax)}</Td>
                      <Td right className="font-semibold">
                        {moneyCents(r.totalOutstanding, currency)}
                      </Td>
                      <Td right>
                        {m(r.par30)} <span className="text-xs text-muted-foreground">({r.principal ? ((r.par30 / r.principal) * 100).toFixed(1) : '0.0'}%)</span>
                      </Td>
                      <Td right>
                        {m(r.par90)} <span className="text-xs text-muted-foreground">({r.principal ? ((r.par90 / r.principal) * 100).toFixed(1) : '0.0'}%)</span>
                      </Td>
                      <Td right>{r.nplBorrowers}</Td>
                      <Td>{r.accruedThrough ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          );
        })()}

      {tab.key === 'aging' &&
        (async () => {
          const rows = await agingReport(providerId);
          const total = rows.reduce((t, r) => ({ loans: t.loans + r.loans, principal: t.principal + r.principal, outstanding: t.outstanding + r.totalOutstanding }), { loans: 0, principal: 0, outstanding: 0 });
          return (
            <TableCard>
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <Th>Days past due</Th>
                    <Th right>Loans</Th>
                    <Th right>Principal</Th>
                    <Th right>Share</Th>
                    <Th right>Total outstanding</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.bucket}>
                      <Td>{r.bucket}</Td>
                      <Td right>{r.loans}</Td>
                      <Td right>{m(r.principal)}</Td>
                      <Td right>{total.principal ? `${((r.principal / total.principal) * 100).toFixed(1)}%` : '—'}</Td>
                      <Td right>{m(r.totalOutstanding)}</Td>
                    </tr>
                  ))}
                  <tr className="bg-secondary/40 font-semibold">
                    <Td>Total</Td>
                    <Td right>{total.loans}</Td>
                    <Td right>{moneyCents(total.principal, currency)}</Td>
                    <Td right>100%</Td>
                    <Td right>{moneyCents(total.outstanding, currency)}</Td>
                  </tr>
                </tbody>
              </table>
            </TableCard>
          );
        })()}

      {tab.key === 'collections' &&
        (async () => {
          const { rows, total, byChannel } = await collectionsReport(from, to, providerId);
          return (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                By channel:{' '}
                {Object.entries(byChannel).map(([channel, v]) => `${channel} ${v.receipts} receipts, ${moneyCents(v.amount, currency)}`).join(' · ') || 'none'}
              </p>
              <TableCard>
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="border-b border-border bg-secondary/50 text-left">
                    <tr>
                      <Th>Date</Th>
                      <Th right>Receipts</Th>
                      <Th right>Amount</Th>
                      <Th right>Principal</Th>
                      <Th right>Interest</Th>
                      <Th right>Fees</Th>
                      <Th right>Penalties</Th>
                      <Th right>Tax</Th>
                      <Th right>Overpaid</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.length === 0 && <EmptyRow colSpan={9} message="No collections in this range." />}
                    {[...rows, ...(rows.length ? [total] : [])].map((r) => (
                      <tr key={r.date} className={r.date === 'Total' ? 'bg-secondary/40 font-semibold' : ''}>
                        <Td>{r.date}</Td>
                        <Td right>{r.receipts}</Td>
                        <Td right>{m(r.amount)}</Td>
                        <Td right>{m(r.principal)}</Td>
                        <Td right>{m(r.interest)}</Td>
                        <Td right>{m(r.fee)}</Td>
                        <Td right>{m(r.penalty)}</Td>
                        <Td right>{m(r.tax)}</Td>
                        <Td right>{m(r.excess)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            </>
          );
        })()}

      {tab.key === 'income' &&
        (async () => {
          const rows = await incomeReport(from, to, providerId);
          return (
            <TableCard>
              <table className="w-full min-w-[1000px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <Th>Provider</Th>
                    <Th right>Interest earned</Th>
                    <Th right>Fees earned</Th>
                    <Th right>Penalties earned</Th>
                    <Th right>Write-offs</Th>
                    <Th right>Net income</Th>
                    <Th right>Interest collected</Th>
                    <Th right>Fees collected</Th>
                    <Th right>Penalties collected</Th>
                    <Th right>Tax charged / collected</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.providerId}>
                      <Td>{r.providerName}</Td>
                      <Td right>{m(r.interestEarned)}</Td>
                      <Td right>{m(r.feeEarned)}</Td>
                      <Td right>{m(r.penaltyEarned)}</Td>
                      <Td right>{m(r.writeOffs)}</Td>
                      <Td right className="font-semibold">
                        {moneyCents(r.netIncome, currency)}
                      </Td>
                      <Td right>{m(r.interestCollected)}</Td>
                      <Td right>{m(r.feeCollected)}</Td>
                      <Td right>{m(r.penaltyCollected)}</Td>
                      <Td right>
                        {m(r.taxCharged)} / {m(r.taxCollected)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                Earned figures net out reversals within the period (a write-off reverses unpaid accrued income). Collected figures come from posted receipts.
              </p>
            </TableCard>
          );
        })()}

      {tab.key === 'disbursements' &&
        (async () => {
          const rows = await disbursementsReport(from, to, providerId);
          return (
            <TableCard>
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <Th>Requested</Th>
                    <Th>Loan</Th>
                    <Th>Borrower</Th>
                    <Th>Account</Th>
                    <Th right>Amount</Th>
                    <Th>Disbursement</Th>
                    <Th>Loan</Th>
                    <Th>CBS reference</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && <EmptyRow colSpan={8} message="No disbursements in this range." />}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td className="text-xs">{formatDateTime(r.requestedAt)}</Td>
                      <Td>
                        <Link href={`/admin/loans/${r.loanId}`} className="font-mono text-primary hover:underline">
                          {r.loanNumber}
                        </Link>
                        {!providerId && <p className="text-xs text-muted-foreground">{r.provider}</p>}
                      </Td>
                      <Td>
                        {r.borrowerName ?? '—'}
                        <p className="font-mono text-xs text-muted-foreground">{r.borrowerPhone}</p>
                      </Td>
                      <Td className="font-mono">{maskAccount(r.account)}</Td>
                      <Td right>{m(r.amount)}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td>
                        <StatusBadge status={r.loanStatus} />
                      </Td>
                      <Td className="font-mono text-xs">{r.cbsReference ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          );
        })()}
    </>
  );
}
