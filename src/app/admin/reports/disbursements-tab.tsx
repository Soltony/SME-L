import Link from 'next/link';
import type { Day } from '@/lib/business-date';
import { formatDateTime, maskAccount } from '@/lib/format';
import { disbursementsReport } from '@/lib/reports';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { moneyCents } from '@/components/money';
import { Td, Th, THead } from './report-table';

export async function DisbursementsTab({ providerId, from, to }: { providerId: string | null; from: Day; to: Day }) {
  const rows = await disbursementsReport(from, to, providerId);
  return (
    <TableCard>
      <table className="w-full min-w-[1100px] text-sm">
        <THead>
          <Th>Requested</Th>
          <Th>Loan</Th>
          <Th>Borrower</Th>
          <Th>Account</Th>
          <Th right>Amount</Th>
          <Th>Disbursement</Th>
          <Th>Loan</Th>
          <Th>CBS reference</Th>
        </THead>
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
              <Td right>{moneyCents(r.amount)}</Td>
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
}
