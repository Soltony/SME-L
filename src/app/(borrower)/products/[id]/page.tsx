import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarDays, ChevronLeft, Coins, Percent, ShieldCheck } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { productCard } from '@/lib/lending/product-view';
import { parsePenaltyRules } from '@/lib/lending/terms';
import { borrowerPhoneNumbers } from '@/lib/lending/borrower-identity';
import { visibleToBorrower } from '@/lib/lending/eligibility-lists';
import { alpha, brandStyle, brandTokens, honeycomb } from '@/lib/brand';
import { ProviderIcon } from '@/components/provider-icon';
import { money } from '@/components/money';
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
  const { borrower } = await requireBorrowerPage();
  const { id } = await params;
  const numbers = await borrowerPhoneNumbers(prisma, borrower);
  // A list-only product is not found at all by someone who is not on the list.
  const product = await prisma.loanProduct.findFirst({
    where: { id, ...visibleToBorrower(numbers) },
    include: { provider: { select: { id: true, name: true, colorHex: true, icon: true, status: true } } },
  });
  if (!product || product.status !== 'ACTIVE' || product.provider.status !== 'ACTIVE') notFound();
  const card = productCard(product);
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const penalties = parsePenaltyRules(product.penaltyRules);
  const { foreground } = brandTokens(card.providerColor);

  const facts: { icon: typeof Coins; label: string; value: string }[] = [
    {
      icon: CalendarDays,
      label: 'Term',
      value: `${card.durationDays} days${card.installmentCount > 1 ? `, ${card.installmentCount} installments` : ', one repayment'}`,
    },
    { icon: Coins, label: 'Service fee', value: card.serviceFee },
    { icon: Percent, label: 'Interest', value: card.interest },
    { icon: ShieldCheck, label: 'Decision', value: card.requiresReview ? 'Reviewed by an officer' : 'Instant' },
  ];

  return (
    <div className="space-y-4">
      <Link href={`/home?lender=${card.providerId}`} className="inline-flex items-center text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>

      <header className="brand-surface relative overflow-hidden rounded-2xl p-4 shadow-lg" style={brandStyle(card.providerColor)}>
        <div className="pointer-events-none absolute inset-0 opacity-60" style={honeycomb(foreground, 0.22)} aria-hidden />
        <div className="relative">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide opacity-85">
            <ProviderIcon icon={card.providerIcon} className="h-3.5 w-3.5" />
            {card.providerName}
          </p>
          <h1 className="mt-0.5 text-xl font-bold tracking-tight">{card.name}</h1>
          <p className="num mt-2 text-sm opacity-90">
            {currency} {money(card.minAmount)} – {money(card.maxAmount)}
          </p>
          {card.description && <p className="mt-2 text-sm opacity-90">{card.description}</p>}
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-2">
        {facts.map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Icon className="h-3.5 w-3.5" style={{ color: card.providerColor }} />
              {label}
            </dt>
            <dd className="mt-0.5 text-sm font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      {penalties.length > 0 && (
        <section
          className="rounded-xl border p-3 text-xs"
          style={{ borderColor: alpha(card.providerColor, 0.3), backgroundColor: alpha(card.providerColor, 0.07) }}
        >
          <h2 className="text-sm font-semibold">If you pay late</h2>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {penalties.map((rule, i) => (
              <li key={i}>{describePenalty(rule)}</li>
            ))}
          </ul>
        </section>
      )}

      <ApplyFlow
        productId={product.id}
        currency={currency}
        requiresReview={product.requiresReview}
        colorHex={card.providerColor}
      />
    </div>
  );
}
