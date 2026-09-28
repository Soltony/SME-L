import Link from 'next/link';
import { maskAccount } from '@/lib/format';
import { NBE_CLASSES, nbeLabel, type NbeClass } from '@/lib/report-helpers';
import { agingReport, borrowerAgingReport, classificationReport, nplPrincipal, sumClassification } from '@/lib/reports';
import { EmptyRow, Pager, TableCard } from '@/components/admin/data-shell';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';
import { percentOf, SectionTitle, Td, Th, THead } from './report-table';

const PAGE_SIZE = 50;

export async function AgingTab({
  providerId,
  currency,
  classification,
  q,
  page,
  pagerParams,
}: {
  providerId: string | null;
  currency: string;
  classification: NbeClass | null;
  q?: string;
  page: number;
  pagerParams: Record<string, string | undefined>;
}) {
  const [classes, buckets, borrowers] = await Promise.all([
    classificationReport(providerId),
    agingReport(providerId),
    borrowerAgingReport(providerId, { classification, q }),
  ]);
  const totals = sumClassification(classes);
  const bucketTotal = buckets.reduce((t, r) => ({ loans: t.loans + r.loans, principal: t.principal + r.principal, outstanding: t.outstanding + r.totalOutstanding }), { loans: 0, principal: 0, outstanding: 0 });
  const shown = borrowers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const m = (cents: number) => moneyCents(cents);
  const classRows = classes.length > 1 ? [...classes, { providerId: 'total', providerName: 'Total', ...totals }] : classes;

  return (
    <>
      <SectionTitle
        title="Asset classification"
        description="Every active loan classified by days past due under the National Bank's bands. Each cell is outstanding balance, with the loan count beneath. NPL ratio is substandard, doubtful and loss principal over all principal."
      />
      <TableCard>
        <table className="w-full min-w-[1100px] text-sm">
          <THead>
            <Th>Provider</Th>
            {NBE_CLASSES.map((c) => (
              <Th key={c.key} right>
                {c.label}
                <span className="block text-xs font-normal text-muted-foreground">{c.range}</span>
              </Th>
            ))}
            <Th right>Total</Th>
            <Th right>NPL ratio</Th>
          </THead>
          <tbody className="divide-y divide-border">
            {classRows.length === 0 && <EmptyRow colSpan={NBE_CLASSES.length + 3} message="No providers." />}
            {classRows.map((r) => (
              <tr key={r.providerId} className={r.providerId === 'total' ? 'bg-secondary/40 font-semibold' : ''}>
                <Td>{r.providerName}</Td>
                {NBE_CLASSES.map((c) => (
                  <Td key={c.key} right>
                    {m(r.classes[c.key].outstanding)}
                    <span className="block text-xs font-normal text-muted-foreground">{r.classes[c.key].loans} loans</span>
                  </Td>
                ))}
                <Td right>
                  {moneyCents(r.total.outstanding, currency)}
                  <span className="block text-xs font-normal text-muted-foreground">{r.total.loans} loans</span>
                </Td>
                <Td right className={cn(nplPrincipal(r) > 0 && 'text-destructive')}>
                  {percentOf(nplPrincipal(r), r.total.principal, 2)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <SectionTitle title="Days past due" description="Active loans by how far behind they are, in finer bands than the classification." />
      <TableCard>
        <table className="w-full min-w-[640px] text-sm">
          <THead>
            <Th>Days past due</Th>
            <Th right>Loans</Th>
            <Th right>Principal</Th>
            <Th right>Share</Th>
            <Th right>Total outstanding</Th>
          </THead>
          <tbody className="divide-y divide-border">
            {buckets.map((r) => (
              <tr key={r.bucket}>
                <Td>{r.bucket}</Td>
                <Td right>{r.loans}</Td>
                <Td right>{m(r.principal)}</Td>
                <Td right>{percentOf(r.principal, bucketTotal.principal)}</Td>
                <Td right>{m(r.totalOutstanding)}</Td>
              </tr>
            ))}
            <tr className="bg-secondary/40 font-semibold">
              <Td>Total</Td>
              <Td right>{bucketTotal.loans}</Td>
              <Td right>{moneyCents(bucketTotal.principal, currency)}</Td>
              <Td right>100%</Td>
              <Td right>{moneyCents(bucketTotal.outstanding, currency)}</Td>
            </tr>
          </tbody>
        </table>
      </TableCard>

      <SectionTitle
        title={classification ? `Borrowers classed ${nbeLabel(classification)}` : 'Borrowers past due'}
        description="Each borrower's active loans added together and classed by the most overdue of them. Choose a class above to list borrowers in it, including current ones under Pass."
      />
      <TableCard>
        <table className="w-full min-w-[1200px] text-sm">
          <THead>
            <Th>Borrower</Th>
            <Th>Loans</Th>
            <Th>Account</Th>
            <Th right>Days past due</Th>
            <Th>Class</Th>
            <Th right>Principal</Th>
            <Th right>Overdue principal</Th>
            <Th right>Interest</Th>
            <Th right>Fees</Th>
            <Th right>Penalties</Th>
            <Th right>Tax</Th>
            <Th right>Total outstanding</Th>
          </THead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 && <EmptyRow colSpan={12} message={q || classification ? 'No borrowers match these filters.' : 'No borrower is past due.'} />}
            {shown.map((r) => (
              <tr key={r.borrowerId} className="hover:bg-secondary/30">
                <Td>
                  <Link href={`/admin/borrowers/${r.borrowerId}`} className="font-medium text-primary hover:underline">
                    {r.borrowerName ?? '—'}
                  </Link>
                  <p className="font-mono text-xs text-muted-foreground">{r.phoneNumber}</p>
                  {!providerId && <p className="text-xs text-muted-foreground">{r.providers.join(', ')}</p>}
                </Td>
                <Td>
                  <Link href={`/admin/loans/${r.worstLoanId}`} className="font-mono text-primary hover:underline">
                    {r.loanNumbers.length === 1 ? r.loanNumbers[0] : `${r.loanNumbers.length} loans`}
                  </Link>
                </Td>
                <Td className="font-mono">{r.accounts.map(maskAccount).join(', ')}</Td>
                <Td right className={cn(r.daysPastDue > 0 && 'font-semibold text-destructive')}>
                  {r.daysPastDue}
                </Td>
                <Td>{nbeLabel(r.classification)}</Td>
                <Td right>{m(r.principal)}</Td>
                <Td right>{m(r.overduePrincipal)}</Td>
                <Td right>{m(r.interest)}</Td>
                <Td right>{m(r.fee)}</Td>
                <Td right>{m(r.penalty)}</Td>
                <Td right>{m(r.tax)}</Td>
                <Td right className="font-semibold">
                  {moneyCents(r.totalOutstanding, currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={PAGE_SIZE} total={borrowers.length} basePath="/admin/reports" params={pagerParams} />
      </TableCard>
    </>
  );
}
