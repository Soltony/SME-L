import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { productCard } from '@/lib/lending/product-view';
import { parsePenaltyRules } from '@/lib/lending/terms';
import { ProviderIcon } from '@/components/provider-icon';
import { ApplyFlow } from './apply-flow';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Apply' };

function describePenalty(rule: ReturnType<typeof parsePenaltyRules>[number]) {
  const range = rule.toDay ? `days ${rule.fromDay}–${rule.toDay}` : `from day ${rule.fromDay}`;
  const amount =
    rule.type === 'FIXED'
      ? `${Number(rule.value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      : `${Number(rule.value)}% of the overdue ${rule.type === 'PERCENT_PRINCIPAL' ? 'amount' : 'amount and unpaid penalty'}`;
  return `${amount} ${rule.frequency === 'ONCE' ? 'once' : 'per day'} (${range} late)`;
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireBorrowerPage();
  const { id } = await params;
  const product = await prisma.loanProduct.findUnique({
    where: { id },
    include: { provider: { select: { name: true, colorHex: true, icon: true, status: true } } },
  });
  if (!product || product.status !== 'ACTIVE' || product.provider.status !== 'ACTIVE') notFound();
  const card = productCard(product);
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const penalties = parsePenaltyRules(product.penaltyRules);

  return (
    <div className="space-y-4">
      <Link href="/home" className="inline-flex items-center text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>
      <header>
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ProviderIcon icon={card.providerIcon} color={card.providerColor} className="h-4 w-4" />
          {card.providerName}
        </p>
        <h1 className="text-xl font-bold">{card.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{card.description}</p>
      </header>

      <dl className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-card p-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Term</dt>
          <dd className="font-semibold">
            {card.durationDays} days{card.installmentCount > 1 ? `, ${card.installmentCount} installments` : ', one repayment'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Service fee</dt>
          <dd className="font-semibold">{card.serviceFee}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Interest</dt>
          <dd className="font-semibold">{card.interest}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Decision</dt>
          <dd className="font-semibold">{card.requiresReview ? 'Reviewed by an officer' : 'Instant'}</dd>
        </div>
        {penalties.length > 0 && (
          <div className="col-span-2">
            <dt className="text-xs text-muted-foreground">If you pay late</dt>
            <dd>
              <ul className="list-inside list-disc text-xs">
                {penalties.map((rule, i) => (
                  <li key={i}>{describePenalty(rule)}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>

      <ApplyFlow productId={product.id} currency={currency} requiresReview={product.requiresReview} documents={card.requiredDocuments} />
    </div>
  );
}
