import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote, Ban, Undo2 } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { dayFromDate, formatDay } from '@/lib/business-date';
import { formatDateTime, maskAccount } from '@/lib/format';
import { toCents } from '@/lib/money';
import { buildLoanView, buildRepaymentView } from '@/lib/lending/loan-view';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { TableCard, EmptyRow } from '@/components/admin/data-shell';
import { ActionDialog } from '@/components/admin/action-dialog';
import { money, moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Loan' };

function describeTerms(v: ReturnType<typeof buildLoanView>) {
  const t = v.terms;
  const fee = t.serviceFee.type === 'PERCENT' ? `${t.serviceFee.value}% fee` : t.serviceFee.type === 'FIXED' ? `${t.serviceFee.value} fee` : 'no fee';
  const interest =
    t.interest.type === 'PERCENT_DAILY'
      ? `${t.interest.value}% a day ${t.interest.basis === 'COMPOUND' ? 'compounding' : 'simple'}${t.interest.afterMaturity ? ', continuing after maturity' : ''}`
      : t.interest.type === 'FIXED_DAILY'
        ? `${t.interest.value} a day`
        : 'no interest';
  const taxes = t.taxes.length ? t.taxes.map((x) => `${x.name} ${x.ratePercent}%`).join(', ') : 'no tax';
  return `${t.durationDays} days · ${t.installmentCount} installment${t.installmentCount === 1 ? '' : 's'} · ${fee} · ${interest} · ${taxes}`;
}

export default async function LoanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;

  const loan = await prisma.loan.findUnique({
    where: { id },
    include: {
      installments: true,
      product: { select: { name: true } },
      provider: { select: { name: true } },
      borrower: { select: { id: true, phoneNumber: true, fullName: true, isNpl: true } },
      application: { select: { id: true, applicationNo: true } },
      repayments: { orderBy: { receivedAt: 'desc' } },
      disbursements: { orderBy: { attemptNo: 'desc' } },
      journals: {
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        take: 200,
        include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      },
    },
  });
  if (!loan || (user.providerId && loan.providerId !== user.providerId)) notFound();

  const view = buildLoanView(loan);
  const c = view.currency;
  const pending = await prisma.pendingChange.findMany({
    where: {
      status: 'PENDING',
      OR: [{ entityId: loan.id }, { entityId: { in: loan.repayments.map((r) => r.id) } }, { entityId: { in: loan.disbursements.map((d) => d.id) } }],
    },
    select: { id: true, summary: true },
  });

  const canRepay = hasPermission(user, 'repayments', 'create') && view.status === 'ACTIVE';
  const canWriteOff = hasPermission(user, 'loans', 'update') && view.status === 'ACTIVE';
  const canRefund = hasPermission(user, 'loans', 'update') && view.credit > 0;
  const canReverse = hasPermission(user, 'repayments', 'update');

  const cards = [
    { label: 'Owed today', value: view.outstanding.total, strong: true },
    { label: 'Principal', value: view.outstanding.principal },
    { label: 'Interest', value: view.outstanding.interest },
    { label: 'Service fee', value: view.outstanding.fee },
    { label: 'Penalty', value: view.outstanding.penalty },
    { label: 'Tax', value: view.outstanding.tax },
  ];

  return (
    <>
      <PageHeader
        title={loan.loanNumber}
        breadcrumbs={[{ label: 'Loans', href: '/admin/loans' }, { label: loan.loanNumber }]}
        description={`${view.productName} · ${view.providerName}`}
        actions={
          <>
            <StatusBadge status={view.status} className="mr-1" />
            {canRepay && (
              <ActionDialog
                label="Record repayment"
                icon={<Banknote className="mr-1.5 h-3.5 w-3.5" />}
                title="Record a manual repayment"
                description="For money received outside the wallet (branch cash, bank transfer). It posts only after a second person approves it, and is applied penalty → fee → interest → tax → principal."
                endpoint={`/api/admin/loans/${loan.id}`}
                extra={{ action: 'manual-repayment' }}
                submitLabel="Send for approval"
                fields={[
                  { name: 'amount', label: `Amount (${c})`, type: 'amount', required: true, help: `Owed today: ${money(view.outstanding.total, c)}` },
                  { name: 'reference', label: 'Bank or teller reference', required: true, placeholder: 'e.g. FT2609160042' },
                  { name: 'note', label: 'Note', type: 'textarea' },
                ]}
              />
            )}
            {canRefund && (
              <ActionDialog
                label="Refund overpayment"
                title="Refund an overpayment"
                description={`${money(view.credit, c)} is held for this borrower.`}
                endpoint={`/api/admin/loans/${loan.id}`}
                extra={{ action: 'refund' }}
                submitLabel="Send for approval"
                fields={[
                  { name: 'amount', label: `Amount (${c})`, type: 'amount', required: true, defaultValue: view.credit.toFixed(2) },
                  { name: 'reference', label: 'Payout reference', required: true },
                ]}
              />
            )}
            {canWriteOff && (
              <ActionDialog
                label="Write off"
                icon={<Ban className="mr-1.5 h-3.5 w-3.5" />}
                destructive
                title="Write off this loan"
                description="Removes every outstanding balance from the books: principal to write-off expense, unpaid interest, fees and penalties reversed out of income. Accrual stops. Needs approval."
                endpoint={`/api/admin/loans/${loan.id}`}
                extra={{ action: 'write-off' }}
                submitLabel="Request write-off"
                fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
              />
            )}
          </>
        }
      />

      {pending.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <strong>Awaiting approval:</strong>{' '}
          {pending.map((p, i) => (
            <span key={p.id}>
              {i > 0 && '; '}
              <Link href="/admin/approvals" className="underline">
                {p.summary}
              </Link>
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="panel p-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={`num mt-1 ${card.strong ? 'text-xl font-bold' : 'text-lg font-semibold'}`}>{money(card.value)}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 text-sm lg:col-span-2">
          <h2 className="mb-3 font-semibold">Loan</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Borrower</dt>
              <dd>
                <Link href={`/admin/borrowers/${loan.borrower.id}`} className="text-primary hover:underline">
                  {loan.borrower.fullName ?? loan.borrower.phoneNumber}
                </Link>
                {loan.borrower.isNpl && <StatusBadge status="NPL" className="ml-1" />}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Principal</dt>
              <dd className="num">{money(view.principal, c)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Paid to account</dt>
              <dd className="font-mono">{maskAccount(view.disbursementAccount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Disbursed</dt>
              <dd>{view.disbursementDate ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Maturity</dt>
              <dd>{view.maturityDate ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Days past due</dt>
              <dd className={view.daysPastDue > 0 ? 'font-semibold text-destructive' : ''}>
                {view.daysPastDue} {loan.maxDaysPastDue > 0 && <span className="text-xs text-muted-foreground">(worst {loan.maxDaysPastDue})</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Application</dt>
              <dd>
                <Link href={`/admin/applications/${loan.application.id}`} className="font-mono text-primary hover:underline">
                  {loan.application.applicationNo}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Accrued in ledger through</dt>
              <dd>{view.accruedThrough ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Overpayment held</dt>
              <dd className="num">{money(view.credit, c)}</dd>
            </div>
          </dl>
          <p className="mt-4 rounded-md bg-secondary/60 p-2 text-xs text-muted-foreground">
            <strong>Terms (fixed at origination):</strong> {describeTerms(view)}
          </p>
        </section>
        <section className="panel p-4 text-sm">
          <h2 className="mb-3 font-semibold">Lifetime</h2>
          <dl className="space-y-1.5">
            {[
              ['Interest charged', view.lifetime.interestAccrued],
              ['Fees charged', view.lifetime.feeCharged],
              ['Penalties charged', view.lifetime.penaltyAccrued],
              ['Tax charged', view.lifetime.taxAccrued],
              ['Principal repaid', view.lifetime.principalPaid],
              ['Interest repaid', view.lifetime.interestPaid],
              ['Fees repaid', view.lifetime.feePaid],
              ['Penalties repaid', view.lifetime.penaltyPaid],
              ['Tax repaid', view.lifetime.taxPaid],
              ['Written off', view.lifetime.writtenOff],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="num">{money(value as number)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <h2 className="mb-2 mt-6 font-semibold">Schedule</h2>
      <TableCard>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">#</th>
              <th className="px-4 py-2 font-semibold">Due</th>
              <th className="px-4 py-2 text-right font-semibold">Principal due</th>
              <th className="px-4 py-2 text-right font-semibold">Principal paid</th>
              <th className="px-4 py-2 text-right font-semibold">Penalty</th>
              <th className="px-4 py-2 text-right font-semibold">Penalty paid</th>
              <th className="px-4 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view.installments.length === 0 && <EmptyRow colSpan={7} message="The schedule is created when the loan is disbursed." />}
            {view.installments.map((i) => (
              <tr key={i.number}>
                <td className="px-4 py-2">{i.number}</td>
                <td className="px-4 py-2">{i.dueDate}</td>
                <td className="num px-4 py-2 text-right">{money(i.principalDue)}</td>
                <td className="num px-4 py-2 text-right">{money(i.principalPaid)}</td>
                <td className="num px-4 py-2 text-right">{money(i.penaltyAccrued)}</td>
                <td className="num px-4 py-2 text-right">{money(i.penaltyPaid)}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={i.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <h2 className="mb-2 mt-6 font-semibold">Repayments</h2>
      <TableCard>
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">Receipt</th>
              <th className="px-4 py-2 font-semibold">Value date</th>
              <th className="px-4 py-2 font-semibold">Channel</th>
              <th className="px-4 py-2 text-right font-semibold">Amount</th>
              <th className="px-4 py-2 text-right font-semibold">Principal</th>
              <th className="px-4 py-2 text-right font-semibold">Interest</th>
              <th className="px-4 py-2 text-right font-semibold">Fee</th>
              <th className="px-4 py-2 text-right font-semibold">Penalty</th>
              <th className="px-4 py-2 text-right font-semibold">Tax</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loan.repayments.length === 0 && <EmptyRow colSpan={11} message="No repayments yet." />}
            {loan.repayments.map((r) => {
              const v = buildRepaymentView(r);
              return (
                <tr key={r.id} className="align-top">
                  <td className="px-4 py-2 font-mono">{v.receiptNo}</td>
                  <td className="px-4 py-2">{v.valueDate}</td>
                  <td className="px-4 py-2">
                    {v.channel}
                    {v.externalReference && <p className="text-xs text-muted-foreground">{v.externalReference}</p>}
                  </td>
                  <td className="num px-4 py-2 text-right font-medium">{money(v.amount)}</td>
                  <td className="num px-4 py-2 text-right">{money(v.principal)}</td>
                  <td className="num px-4 py-2 text-right">{money(v.interest)}</td>
                  <td className="num px-4 py-2 text-right">{money(v.fee)}</td>
                  <td className="num px-4 py-2 text-right">{money(v.penalty)}</td>
                  <td className="num px-4 py-2 text-right">{money(v.tax)}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={v.status} />
                    {v.excess > 0 && <p className="text-xs text-muted-foreground">{money(v.excess)} overpaid</p>}
                    {v.reversalReason && <p className="max-w-[180px] text-xs text-muted-foreground">{v.reversalReason}</p>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canReverse && v.status === 'POSTED' && view.status !== 'WRITTEN_OFF' && (
                      <ActionDialog
                        label="Reverse"
                        icon={<Undo2 className="mr-1 h-3.5 w-3.5" />}
                        variant="ghost"
                        destructive
                        title={`Reverse ${v.receiptNo}`}
                        description="Posts the mirror-image journal and puts the amounts back on the loan. Charges accrued since are not recomputed. Needs approval."
                        endpoint={`/api/admin/repayments/${r.id}`}
                        submitLabel="Request reversal"
                        fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>

      <h2 className="mb-2 mt-6 font-semibold">Disbursement attempts</h2>
      <TableCard>
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">#</th>
              <th className="px-4 py-2 font-semibold">Requested</th>
              <th className="px-4 py-2 font-semibold">Account</th>
              <th className="px-4 py-2 text-right font-semibold">Amount</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">CBS reference</th>
              <th className="px-4 py-2 font-semibold">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loan.disbursements.map((d) => (
              <tr key={d.id} className="align-top">
                <td className="px-4 py-2">{d.attemptNo}</td>
                <td className="px-4 py-2">{formatDateTime(d.createdAt)}</td>
                <td className="px-4 py-2 font-mono">{maskAccount(d.creditAccount)}</td>
                <td className="num px-4 py-2 text-right">{moneyCents(toCents(d.amount))}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={d.status} />
                </td>
                <td className="px-4 py-2 font-mono text-xs">{d.cbsReference ?? '—'}</td>
                <td className="max-w-[260px] px-4 py-2 text-xs text-muted-foreground">
                  {d.errorMessage ?? d.resolutionNote ?? (d.httpStatus ? `HTTP ${d.httpStatus}` : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      {hasPermission(user, 'accounting', 'read') && (
        <>
          <h2 className="mb-2 mt-6 font-semibold">Journals</h2>
          <div className="space-y-2">
            {loan.journals.length === 0 && <div className="panel p-4 text-sm text-muted-foreground">Nothing posted yet.</div>}
            {loan.journals.map((j) => (
              <details key={j.id} className="panel group p-3 text-sm">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">{j.journalNo}</span>{' '}
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-semibold">{j.type}</span>{' '}
                    {j.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDay(dayFromDate(j.businessDate))} · <span className="num">{moneyCents(toCents(j.totalAmount))}</span>
                  </span>
                </summary>
                <table className="mt-2 w-full text-xs">
                  <tbody className="divide-y divide-border">
                    {j.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-1 pr-2 font-mono text-muted-foreground">{line.account.code}</td>
                        <td className="py-1 pr-2">{line.account.name}</td>
                        <td className="py-1 pr-2 text-muted-foreground">{line.memo}</td>
                        <td className="num py-1 text-right">{toCents(line.debit) ? moneyCents(toCents(line.debit)) : ''}</td>
                        <td className="num py-1 pl-4 text-right">{toCents(line.credit) ? moneyCents(toCents(line.credit)) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
        </>
      )}
    </>
  );
}
