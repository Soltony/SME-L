import { portfolioReport } from '@/lib/reports';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { moneyCents } from '@/components/money';
import { Td, Th, THead } from './report-table';

export async function PortfolioTab({ providerId, currency }: { providerId: string | null; currency: string }) {
  const rows = await portfolioReport(providerId);
  const m = (cents: number) => moneyCents(cents);
  return (
    <TableCard>
      <table className="w-full min-w-[1100px] text-sm">
        <THead>
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
        </THead>
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
}
