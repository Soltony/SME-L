import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { buildLoanView, buildRepaymentView } from '@/lib/lending/loan-view';
import { maskAccount } from '@/lib/format';
import { StatusBadge } from '@/components/admin/status-badge';
import { money } from '@/components/money';
import { RepayPanel } from './repay-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Loan' };

export default async function BorrowerLoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { borrower, session } = await requireBorrowerPage();
  const { id } = await params;
  const loan = await prisma.loan.findFirst({
    where: { id, borrowerId: borrower.id },
    include: {
      installments: true,
      product: { select: { name: true } },
      provider: { select: { name: true } },
      repayments: { orderBy: { receivedAt: 'desc' }, take: 30 },
    },
  });
  if (!loan) notFound();
  const v = buildLoanView(loan);
  const c = v.currency;

  return (
    <div className="space-y-4">
      <Link href="/loans" className="inline-flex items-center text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> My loans
      </Link>

      <section className="ink rounded-2xl p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-[hsl(var(--ink-muted))]">
              {v.providerName} · {v.loanNumber}
            </p>
            <h1 className="text-lg font-bold">{v.productName}</h1>
          </div>
          <StatusBadge status={v.status} />
        </div>
        {v.status === 'ACTIVE' ? (
          <>
            <p className="mt-3 text-xs text-[hsl(var(--ink-muted))]">To clear this loan today</p>
            <p className="num text-3xl font-bold">{money(v.outstanding.total, c)}</p>
            {v.daysPastDue > 0 ? (
              <p className="mt-1 text-sm font-semibold text-[hsl(var(--warning))]">
                {v.daysPastDue} day(s) overdue — pay {money(v.amountDueNow, c)} to catch up
              </p>
            ) : v.nextInstallment ? (
              <p className="mt-1 text-sm text-[hsl(var(--ink-muted))]">
                Next: {money(v.nextInstallment.amount)} principal plus charges by {v.nextInstallment.dueDate}
              </p>
            ) : null}
          </>
        ) : v.status === 'PENDING_DISBURSEMENT' ? (
          <p className="mt-3 text-sm">We are sending {money(v.principal, c)} to account {maskAccount(v.disbursementAccount)}. You will get an SMS when it arrives.</p>
        ) : v.status === 'PAID_OFF' ? (
          <p className="mt-3 text-sm">Fully repaid. Thank you!{v.credit > 0 ? ` We hold ${money(v.credit, c)} you overpaid and will refund it.` : ''}</p>
        ) : v.status === 'DISBURSEMENT_FAILED' ? (
          <p className="mt-3 text-sm">The bank could not send this loan. Nothing is owed.</p>
        ) : (
          <p className="mt-3 text-sm">This loan is closed.</p>
        )}
      </section>

      {v.status === 'ACTIVE' && (
        <RepayPanel loanId={v.id} currency={c} payoff={v.outstanding.total} dueNow={v.amountDueNow} isTest={Boolean(session.isTest)} />
      )}

      {v.status === 'ACTIVE' && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 font-semibold">What you owe</h2>
          <dl className="space-y-1">
            {[
              ['Principal', v.outstanding.principal],
              ['Interest', v.outstanding.interest],
              ['Service fee', v.outstanding.fee],
              ['Late penalties', v.outstanding.penalty],
              ['Tax', v.outstanding.tax],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="num">{money(value as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">Payments settle penalties first, then fees, interest and tax, then principal.</p>
        </section>
      )}

      {v.installments.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Schedule</h2>
          <ul className="divide-y divide-border">
            {v.installments.map((i) => (
              <li key={i.number} className="flex items-center justify-between py-2">
                <span>
                  <span className="block">Installment {i.number}</span>
                  <span className="block text-xs text-muted-foreground">Due {i.dueDate}</span>
                </span>
                <span className="text-right">
                  <span className="num block">{money(i.principalDue - i.principalPaid)}</span>
                  <StatusBadge status={i.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loan.repayments.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 font-semibold">Payments</h2>
          <ul className="divide-y divide-border">
            {loan.repayments.map((r) => {
              const rv = buildRepaymentView(r);
              return (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <span>
                    <span className="block">{rv.valueDate}</span>
                    <span className="block text-xs text-muted-foreground">Receipt {rv.receiptNo}</span>
                  </span>
                  <span className="text-right">
                    <span className={`num block ${rv.status === 'REVERSED' ? 'line-through text-muted-foreground' : ''}`}>{money(rv.amount)}</span>
                    {rv.status === 'REVERSED' && <span className="text-[11px] text-destructive">Reversed</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
