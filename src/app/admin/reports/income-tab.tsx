import type { Day } from '@/lib/business-date';
import { incomeReport } from '@/lib/reports';
import { TableCard } from '@/components/admin/data-shell';
import { moneyCents } from '@/components/money';
import { Td, Th, THead } from './report-table';

export async function IncomeTab({ providerId, from, to, currency }: { providerId: string | null; from: Day; to: Day; currency: string }) {
  const rows = await incomeReport(from, to, providerId);
  const m = (cents: number) => moneyCents(cents);
  return (
    <TableCard>
      <table className="w-full min-w-[1000px] text-sm">
        <THead>
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
        </THead>
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
}
