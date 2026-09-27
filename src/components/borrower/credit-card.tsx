'use client';

import { useState } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { brandStyle, brandTokens, honeycomb } from '@/lib/brand';
import { money } from '@/components/money';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The borrower's credit with one lender, on a card in that lender's colour.
 *
 * Two figures matter and they are easy to confuse, so they sit side by side
 * with the same weight: the limit the lender has approved, and what is left of
 * it after the loans they are already carrying. The meter below is the
 * difference made visible — it fills with what is still free to borrow, so a
 * borrower sees they are near their ceiling without doing the subtraction.
 *
 * Each figure hides on its own, because a borrower opening the app on a taxi
 * is standing next to a stranger.
 */
export function CreditCard({
  providerName,
  colorHex,
  holderName,
  accountNumber,
  accountCount,
  statusLabel,
  maxLimit,
  available,
  currency,
  loading,
  onOpenAccounts,
}: {
  providerName: string;
  colorHex: string;
  holderName: string;
  accountNumber: string | null;
  accountCount: number;
  statusLabel: string;
  maxLimit: number;
  available: number;
  currency: string;
  loading: boolean;
  onOpenAccounts: () => void;
}) {
  const [showLimit, setShowLimit] = useState(true);
  const [showAvailable, setShowAvailable] = useState(true);
  // White text on every lender's colour; a light colour is deepened to keep it readable.
  const { foreground, isLight } = brandTokens(colorHex, { lightText: true });
  const free = maxLimit > 0 ? Math.max(0, Math.min(100, Math.round((available / maxLimit) * 100))) : 0;

  const figure = (
    label: string,
    value: number,
    visible: boolean,
    toggle: () => void,
    align: 'left' | 'right'
  ) => (
    <div className={align === 'right' ? 'text-right' : 'text-left'}>
      <div className={cn('flex items-center gap-1.5', align === 'right' && 'justify-end')}>
        <span className="text-xs opacity-75">{label}</span>
        <button
          type="button"
          onClick={toggle}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="rounded p-0.5 opacity-75 outline-none transition-opacity hover:opacity-100 focus-visible:ring-1 focus-visible:ring-current"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      </div>
      {loading ? (
        <Skeleton className={cn('mt-1 h-6 w-28', isLight ? 'bg-black/10' : 'bg-white/20', align === 'right' && 'ml-auto')} />
      ) : (
        // Both figures share the width of a phone, so the currency is a small
        // mark rather than a word, and a long amount steps down a size instead
        // of colliding with the one opposite it.
        <p className={cn('num font-bold leading-tight tracking-tight', money(value).length > 10 ? 'text-base' : 'text-lg')}>
          {visible ? (
            <>
              <span className="mr-1 align-baseline text-[0.62em] font-semibold opacity-70">{currency}</span>
              {money(value)}
            </>
          ) : (
            '••••••'
          )}
        </p>
      )}
    </div>
  );

  return (
    // Edge to edge: it runs the full width of the screen, past the page's side
    // gutter, while its content stays in line with everything below it.
    <section
      className="brand-surface relative -mx-4 overflow-hidden shadow-lg"
      style={brandStyle(colorHex, { lightText: true })}
      aria-label={`Your credit with ${providerName}`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-60" style={honeycomb(foreground, 0.22)} aria-hidden />

      {/*
       * Kept short on purpose: on a phone the card shares the first screen with
       * the product list, and the borrower should see at least two products
       * without scrolling.
       */}
      <div className="relative px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onOpenAccounts}
            className="min-w-0 flex-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-current"
          >
            <p className="truncate text-[11px] uppercase tracking-wide opacity-75">{holderName}</p>
            <p className="num flex items-center gap-1 text-base font-bold leading-snug tracking-wide">
              <span className="truncate">{accountNumber ?? 'No bank account yet'}</span>
              {accountCount > 1 && (
                <span className="shrink-0 text-[11px] font-medium tracking-normal opacity-70">· {accountCount} accounts</span>
              )}
              <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />
            </p>
          </button>
          <span
            className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={{ backgroundColor: 'var(--brand-chip)' }}
          >
            {statusLabel}
          </span>
        </div>

        <div className="my-2.5 h-px" style={{ backgroundColor: 'var(--brand-line)' }} />

        <div className="flex items-end justify-between gap-3">
          {figure('Max Limit', maxLimit, showLimit, () => setShowLimit((v) => !v), 'left')}
          {figure('Available', available, showAvailable, () => setShowAvailable((v) => !v), 'right')}
        </div>

        {!loading && maxLimit > 0 && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--brand-line)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                // Dark ink on a pale brand reads much heavier than white on a
                // dark one, so the fill is softened where it would shout.
                style={{ width: `${free}%`, backgroundColor: foreground, opacity: isLight ? 0.5 : 0.85 }}
              />
            </div>
            <span className="num shrink-0 text-[11px] font-medium opacity-75">
              {free === 0 ? 'Fully used' : `${free}% free`}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
