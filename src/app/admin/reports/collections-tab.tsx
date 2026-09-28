import type { Day } from '@/lib/business-date';
import { collectionsReport } from '@/lib/reports';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { moneyCents } from '@/components/money';
import { Td, Th, THead } from './report-table';

export async function CollectionsTab({ providerId, from, to, currency }: { providerId: string | null; from: Day; to: Day; currency: string }) {
  const { rows, total, byChannel } = await collectionsReport(from, to, providerId);
  const m = (cents: number) => moneyCents(cents);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        By channel:{' '}
        {Object.entries(byChannel).map(([channel, v]) => `${channel} ${v.receipts} receipts, ${moneyCents(v.amount, currency)}`).join(' · ') || 'none'}
      </p>
      <TableCard>
        <table className="w-full min-w-[900px] text-sm">
          <THead>
            <Th>Date</Th>
            <Th right>Receipts</Th>
            <Th right>Amount</Th>
            <Th right>Principal</Th>
            <Th right>Interest</Th>
            <Th right>Fees</Th>
            <Th right>Penalties</Th>
            <Th right>Tax</Th>
            <Th right>Overpaid</Th>
          </THead>
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
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Daily totals of posted receipts. Export receipts for each payment, including reversed ones, to reconcile against the bank.
        </p>
      </TableCard>
    </>
  );
}
