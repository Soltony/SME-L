import type { Day } from '@/lib/business-date';
import { fundUtilizationReport } from '@/lib/reports';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';
import { Td, Th, THead } from './report-table';

export async function FundUtilizationTab({ providerId, from, to, currency }: { providerId: string | null; from: Day; to: Day; currency: string }) {
  const rows = await fundUtilizationReport(from, to, providerId);
  const m = (cents: number) => moneyCents(cents);
  return (
    <TableCard>
      <table className="w-full min-w-[1100px] text-sm">
        <THead>
          <Th>Provider</Th>
          <Th right>Capital</Th>
          <Th right>Loan fund (cash)</Th>
          <Th right>Reserved</Th>
          <Th right>Available to lend</Th>
          <Th right>Principal outstanding</Th>
          <Th right>Utilization</Th>
          <Th right>Disbursed in period</Th>
          <Th right>Principal recovered</Th>
        </THead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 && <EmptyRow colSpan={9} message="No providers." />}
          {rows.map((r) => (
            <tr key={r.providerId}>
              <Td>{r.providerName}</Td>
              <Td right>{m(r.capital)}</Td>
              <Td right>{m(r.cash)}</Td>
              <Td right>{m(r.reserved)}</Td>
              <Td right className={cn('font-semibold', r.available < 0 && 'text-destructive')}>
                {moneyCents(r.available, currency)}
              </Td>
              <Td right>{m(r.principalOutstanding)}</Td>
              <Td right>
                {r.utilization === null ? (
                  '—'
                ) : (
                  <span className="inline-flex items-center gap-2">
                    {/* A meter on the same scale in every row, so providers compare at a glance. */}
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary" aria-hidden>
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, r.utilization * 100)}%` }} />
                    </span>
                    {(r.utilization * 100).toFixed(1)}%
                  </span>
                )}
              </Td>
              <Td right>{m(r.disbursed)}</Td>
              <Td right>{m(r.principalRecovered)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Capital, cash and outstanding principal are as of now; the last two columns cover the chosen period. Reserved is principal of loans awaiting disbursement, still in the fund until the bank
        confirms. Utilization is principal outstanding plus reserved, over principal outstanding plus cash.
      </p>
    </TableCard>
  );
}
