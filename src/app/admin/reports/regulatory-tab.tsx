import Link from 'next/link';
import type { Day } from '@/lib/business-date';
import { maskAccount } from '@/lib/format';
import { regulatoryReport } from '@/lib/reports';
import { EmptyRow, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { money, moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';
import { Td, Th, THead } from './report-table';

const PAGE_SIZE = 50;

export async function RegulatoryTab({
  providerId,
  from,
  to,
  currency,
  q,
  page,
  pagerParams,
}: {
  providerId: string | null;
  from: Day;
  to: Day;
  currency: string;
  q?: string;
  page: number;
  pagerParams: Record<string, string | undefined>;
}) {
  const { rows, total, documentTypes } = await regulatoryReport(from, to, providerId, { q, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE });
  const m = (cents: number) => moneyCents(cents);
  const columns = 22 + documentTypes.length;

  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        Loans disbursed in the period, in the shape of the National Bank&apos;s credit register. Region, city, occupation and income come from the core-banking profile; identifier columns are the
        bank&apos;s approved typed documents. Gender and date of birth are not held by the platform. The export carries identifiers and accounts in full.
      </p>
      <TableCard>
        <table className="w-full min-w-[2400px] text-sm">
          <THead>
            <Th>Loan</Th>
            <Th>First name</Th>
            <Th>Middle name</Th>
            <Th>Last name</Th>
            <Th>Phone</Th>
            <Th>Account</Th>
            <Th>Region / city</Th>
            <Th>Occupation</Th>
            <Th right>Monthly income</Th>
            {documentTypes.map((t) => (
              <Th key={t.id}>{t.name}</Th>
            ))}
            <Th right>Applied for</Th>
            <Th right>Approved</Th>
            <Th>Disbursed</Th>
            <Th>Maturity</Th>
            <Th>Repayment</Th>
            <Th>Interest</Th>
            <Th>Service charge</Th>
            <Th right>Outstanding</Th>
            <Th right>DPD</Th>
            <Th>Classification</Th>
            <Th>Settled</Th>
            <Th right>Cycle</Th>
            <Th right>Score</Th>
          </THead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && <EmptyRow colSpan={columns} message={q ? 'No loans match this search.' : 'No loans were disbursed in this range.'} />}
            {rows.map((r) => (
              <tr key={r.loanId} className="hover:bg-secondary/30">
                <Td>
                  <Link href={`/admin/loans/${r.loanId}`} className="font-mono text-primary hover:underline">
                    {r.loanNumber}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {providerId ? r.product : `${r.provider} · ${r.product}`}
                  </p>
                  <StatusBadge status={r.status} className="mt-1" />
                </Td>
                <Td>{r.firstName || '—'}</Td>
                <Td>{r.middleName || '—'}</Td>
                <Td>{r.lastName || '—'}</Td>
                <Td className="font-mono text-xs">{r.phoneNumber}</Td>
                <Td className="font-mono">{maskAccount(r.account)}</Td>
                <Td>{[r.region, r.city].filter(Boolean).join(' / ') || '—'}</Td>
                <Td>{r.occupation || '—'}</Td>
                <Td right>{r.monthlyIncome === null ? '—' : money(r.monthlyIncome)}</Td>
                {documentTypes.map((t) => (
                  <Td key={t.id} className="font-mono">
                    {r.documents[t.id] ? maskAccount(r.documents[t.id]) : '—'}
                  </Td>
                ))}
                <Td right>{m(r.applicationAmount)}</Td>
                <Td right>{m(r.approvedAmount)}</Td>
                <Td className="whitespace-nowrap">{r.disbursementDate}</Td>
                <Td className="whitespace-nowrap">{r.maturityDate ?? '—'}</Td>
                <Td>
                  {r.repaymentFrequency || '—'}
                  {r.durationDays !== null && <p className="text-xs text-muted-foreground">{r.durationDays} days</p>}
                </Td>
                <Td>{r.interestRate || '—'}</Td>
                <Td>{r.serviceCharge || '—'}</Td>
                <Td right className="font-semibold">
                  {moneyCents(r.outstanding, currency)}
                </Td>
                <Td right className={cn(r.daysPastDue > 0 && 'font-semibold text-destructive')}>
                  {r.daysPastDue}
                </Td>
                <Td>{r.classification}</Td>
                <Td className="whitespace-nowrap">{r.settlementDate ?? '—'}</Td>
                <Td right>{r.loanCycle}</Td>
                <Td right>{r.creditScore ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={PAGE_SIZE} total={total} basePath="/admin/reports" params={pagerParams} />
      </TableCard>
    </>
  );
}
