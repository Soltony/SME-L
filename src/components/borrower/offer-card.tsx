'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Info } from 'lucide-react';
import type { ProductOffer } from '@/lib/lending/provider-credit';
import { alpha, normalizeHex, readableOn } from '@/lib/brand';
import { ProviderIcon } from '@/components/provider-icon';
import { money } from '@/components/money';
import { cn } from '@/lib/utils';

/**
 * A product the borrower could apply for.
 *
 * The reference app hid the refusal behind a tooltip on a disabled button,
 * which a thumb cannot open. Here the reason is written under the product, in
 * the lender's own words, because "why not?" is the only question a refused
 * borrower has. The cost breakdown stays folded away: it is what they check
 * before applying, not what they scan the list for.
 */
export function OfferCard({
  offer,
  icon,
  colorHex,
  currency,
}: {
  offer: ProductOffer;
  icon: string;
  colorHex: string;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const color = normalizeHex(colorHex);
  const detailId = `offer-${offer.id}-detail`;

  const details: [string, string][] = [
    ['Term', `${offer.durationDays} days${offer.installmentCount > 1 ? ` · ${offer.installmentCount} installments` : ' · one repayment'}`],
    ['Service fee', offer.serviceFee],
    ['Interest', offer.interest],
    ['Decision', offer.requiresReview ? 'Reviewed by a loan officer' : 'Instant'],
  ];

  return (
    <article className="rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
            style={{ backgroundColor: alpha(color, 0.12), borderColor: alpha(color, 0.3) }}
          >
            <ProviderIcon icon={icon} color={color} className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{offer.name}</h3>
            <p className="num text-xs text-muted-foreground">
              Credit limit {money(offer.minAmount)} to {money(offer.maxAmount)}
            </p>
            {offer.eligible && offer.available > 0 && (
              <p className="num mt-0.5 text-xs font-semibold" style={{ color }}>
                Up to {money(offer.available, currency)} for you
              </p>
            )}
            {offer.eligible && offer.documentsNeeded > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {offer.documentsNeeded === offer.documentsWaiting
                  ? `${offer.documentsNeeded === 1 ? 'Your document is' : 'Your documents are'} being reviewed`
                  : `${offer.documentsNeeded - offer.documentsWaiting} document${offer.documentsNeeded - offer.documentsWaiting === 1 ? '' : 's'} needed to apply`}
              </p>
            )}
          </div>
        </div>

        {/* "More" sits under the button, not on a row of its own, to keep the card short. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          {offer.eligible ? (
            <Link
              href={`/products/${offer.id}`}
              className="inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-semibold shadow-sm transition-transform active:translate-y-px"
              style={{ backgroundColor: color, color: readableOn(color) }}
            >
              Apply
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-muted-foreground">
              Locked
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? 'Less' : 'More'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </div>

      {!offer.eligible && (
        <p className="mt-3 flex gap-2 rounded-xl bg-secondary/70 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {offer.reason}
        </p>
      )}

      {open && (
        <dl id={detailId} className="mt-3 space-y-1 rounded-xl bg-secondary/60 p-3 text-xs">
          {details.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
          {offer.penalties.length > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">If you pay late</dt>
              <dd className="text-right font-medium">
                {offer.penalties.map((p) => (
                  <span key={p} className="block">
                    {p}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {offer.description && <p className="border-t border-border pt-2 text-muted-foreground">{offer.description}</p>}
        </dl>
      )}
    </article>
  );
}
