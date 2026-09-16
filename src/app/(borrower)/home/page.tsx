import Link from 'next/link';
import { AlertTriangle, ChevronRight, Clock } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { productCard } from '@/lib/lending/product-view';
import { buildLoanView } from '@/lib/lending/loan-view';
import { money } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Home' };

export default async function BorrowerHome() {
  const { borrower } = await requireBorrowerPage();
  const [settings, products, loans, pending] = await Promise.all([
    getSettings(),
    prisma.loanProduct.findMany({
      where: { status: 'ACTIVE', provider: { status: 'ACTIVE' } },
      include: { provider: { select: { name: true, colorHex: true, displayOrder: true } } },
      orderBy: [{ provider: { displayOrder: 'asc' } }, { name: 'asc' }],
    }),
    prisma.loan.findMany({
      where: { borrowerId: borrower.id, status: { in: ['ACTIVE', 'PENDING_DISBURSEMENT'] } },
      include: { installments: true, product: { select: { name: true } }, provider: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.loanApplication.findMany({
      where: { borrowerId: borrower.id, status: 'SUBMITTED' },
      include: { product: { select: { name: true } } },
    }),
  ]);
  const currency = String(settings['platform.currency'] || 'ETB');
  const views = loans.map((l) => buildLoanView(l));
  const owed = views.reduce((sum, v) => sum + v.outstanding.total, 0);

  return (
    <div className="space-y-6">
      {borrower.isNpl && (
        <div className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          One of your loans is seriously overdue. Repay it to be able to borrow again.
        </div>
      )}

      {views.length > 0 && (
        <section className="ink rounded-2xl p-4">
          <p className="text-xs text-[hsl(var(--ink-muted))]">You owe today</p>
          <p className="num mt-1 text-3xl font-bold">{money(owed, currency)}</p>
          <ul className="mt-3 space-y-2">
            {views.map((v) => (
              <li key={v.id}>
                <Link href={`/loans/${v.id}`} className="flex items-center justify-between rounded-xl bg-[hsl(var(--ink-raised))] px-3 py-2.5">
                  <span>
                    <span className="block text-sm font-semibold">{v.productName}</span>
                    <span className="block text-xs text-[hsl(var(--ink-muted))]">
                      {v.status === 'PENDING_DISBURSEMENT'
                        ? 'Being sent to your account'
                        : v.daysPastDue > 0
                          ? `${v.daysPastDue} day(s) overdue`
                          : v.nextInstallment
                            ? `Next due ${v.nextInstallment.dueDate}`
                            : `Due ${v.maturityDate}`}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-sm">
                    <span className="num">{money(v.outstanding.total)}</span>
                    <ChevronRight className="h-4 w-4" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-2">
          {pending.map((a) => (
            <Link key={a.id} href={`/applications/${a.id}`} className="flex items-center justify-between rounded-xl border border-border bg-card p-3 text-sm">
              <span className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-warning" />
                {a.product.name} application under review
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-base font-bold">Borrow for your business</h2>
        {products.length === 0 && <p className="text-sm text-muted-foreground">No loan products are open right now.</p>}
        <ul className="space-y-3">
          {products.map((product) => {
            const card = productCard(product);
            return (
              <li key={product.id}>
                <Link href={`/products/${product.id}`} className="block rounded-2xl border border-border bg-card p-4 transition hover:border-primary/60">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: card.providerColor }} />
                        {card.providerName}
                      </p>
                      <h3 className="mt-0.5 font-semibold">{card.name}</h3>
                      {card.requiresReview && <p className="text-[11px] text-muted-foreground">Reviewed by a loan officer</p>}
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{card.description}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Up to</p>
                      <p className="num font-semibold">{money(card.maxAmount)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Term</p>
                      <p className="font-semibold">
                        {card.durationDays} days{card.installmentCount > 1 ? ` · ${card.installmentCount}×` : ''}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Interest</p>
                      <p className="font-semibold">{card.interest}</p>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
