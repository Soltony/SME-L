'use client';

import Link from 'next/link';
import { AlertTriangle, ChevronRight, Clock } from 'lucide-react';
import type { LoanView } from '@/lib/lending/loan-view';
import { alpha, normalizeHex, readableOn } from '@/lib/brand';
import { money } from '@/components/money';
import { cn } from '@/lib/utils';

/**
 * A loan the borrower is carrying, as a card they can act on.
 *
 * The reference app put the amount owed on the right and a Repay button under
 * it, which is the right shape — an overdue borrower should not have to open
 * anything to find out what to pay. Two things are added: the share of
 * principal already repaid, so progress is visible on a long loan, and the
 * penalty shown next to the installment it belongs to rather than folded into
 * the total without explanation.
 */
export function LoanCard({ loan, colorHex }: { loan: LoanView; colorHex: string }) {
  const color = normalizeHex(colorHex);
  const overdue = loan.daysPastDue > 0;
  const pending = loan.status === 'PENDING_DISBURSEMENT';
  const current =
    loan.installments.find((i) => i.status === 'OVERDUE' || i.status === 'DUE_TODAY') ??
    loan.installments.find((i) => i.status === 'UPCOMING');
  const repaidShare = loan.principal > 0 ? Math.min(100, Math.round((loan.lifetime.principalPaid / loan.principal) * 100)) : 0;
  const dueDate = current?.dueDate ?? loan.maturityDate;

  return (
    <article
      className="overflow-hidden rounded-2xl border bg-card shadow-sm"
      style={{ borderColor: overdue ? undefined : alpha(color, 0.28) }}
    >
      {overdue && (
        <p className="flex items-center gap-1.5 bg-destructive/10 px-4 py-1.5 text-xs font-semibold text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {loan.daysPastDue} day{loan.daysPastDue === 1 ? '' : 's'} overdue — pay {money(loan.amountDueNow, loan.currency)} to catch up
        </p>
      )}
      {pending && (
        <p className="flex items-center gap-1.5 bg-warning/15 px-4 py-1.5 text-xs font-semibold text-warning-foreground">
          <Clock className="h-3.5 w-3.5" />
          Being sent to your account
        </p>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-bold" style={{ color }}>
              {loan.productName}
            </h3>
            {dueDate && (
              <p className="text-xs text-muted-foreground">
                Due {dueDate}
                {overdue && <span className="ml-1.5 font-semibold text-destructive">Overdue</span>}
              </p>
            )}
            {current && (
              <p className="text-xs text-muted-foreground">
                Installment {current.number} of {loan.installments.length}
                {loan.outstanding.penalty > 0 && (
                  <span className="ml-1">· Penalty {money(loan.outstanding.penalty)}</span>
                )}
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="num text-xl font-bold leading-tight">{money(loan.outstanding.total)}</p>
            <p className="text-[11px] text-muted-foreground">Outstanding</p>
            <p className="num text-[11px] text-muted-foreground">
              Principal {money(loan.outstanding.principal)} {loan.currency}
            </p>
          </div>
        </div>

        {loan.principal > 0 && !pending && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.max(repaidShare, 2)}%`, backgroundColor: color }}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {repaidShare}% of {money(loan.principal, loan.currency)} principal repaid
            </p>
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <Link
            href={`/loans/${loan.id}`}
            className="inline-flex items-center gap-0.5 rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Details <ChevronRight className="h-3.5 w-3.5" />
          </Link>
          {!pending && (
            <Link
              href={`/loans/${loan.id}#repay`}
              className={cn(
                'inline-flex h-9 items-center justify-center rounded-lg px-5 text-sm font-semibold shadow-sm transition-transform active:translate-y-px'
              )}
              style={{ backgroundColor: color, color: readableOn(color) }}
            >
              Repay
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
