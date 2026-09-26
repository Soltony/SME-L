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
  const { foreground, isLight } = brandTokens(colorHex);
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
        <Skeleton className={cn('mt-1 h-7 w-28', isLight ? 'bg-black/10' : 'bg-white/20', align === 'right' && 'ml-auto')} />
      ) : (
        // Both figures share the width of a phone, so the currency is a small
        // mark rather than a word, and a long amount steps down a size instead
        // of colliding with the one opposite it.
        <p className={cn('num mt-0.5 font-bold tracking-tight', money(value).length > 10 ? 'text-lg' : 'text-xl')}>
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
    <section
      className="brand-surface relative overflow-hidden rounded-2xl shadow-lg"
      style={brandStyle(colorHex)}
      aria-label={`Your credit with ${providerName}`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-60" style={honeycomb(foreground, 0.22)} aria-hidden />

      <div className="relative p-4">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onOpenAccounts}
            className="min-w-0 flex-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-current"
          >
            <p className="truncate text-[11px] uppercase tracking-wide opacity-75">{holderName}</p>
            <p className="num flex items-center gap-1 text-lg font-bold tracking-wide">
              <span className="truncate">{accountNumber ?? 'No bank account yet'}</span>
              <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />
            </p>
            {accountCount > 1 && <p className="text-[11px] opacity-70">{accountCount} accounts · tap to see them</p>}
          </button>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{ backgroundColor: 'var(--brand-chip)' }}
          >
            {statusLabel}
          </span>
        </div>

        <div className="my-3 h-px" style={{ backgroundColor: 'var(--brand-line)' }} />

        <div className="flex items-end justify-between gap-3">
          {figure('Max Limit', maxLimit, showLimit, () => setShowLimit((v) => !v), 'left')}
          {figure('Available', available, showAvailable, () => setShowAvailable((v) => !v), 'right')}
        </div>

        {!loading && maxLimit > 0 && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--brand-line)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                // Dark ink on a pale brand reads much heavier than white on a
                // dark one, so the fill is softened where it would shout.
                style={{ width: `${free}%`, backgroundColor: foreground, opacity: isLight ? 0.5 : 0.85 }}
              />
            </div>
            <p className="mt-1.5 text-[11px] opacity-75">
              {free === 100
                ? 'Your whole limit is free to borrow.'
                : free === 0
                  ? 'Your limit is fully used. Repay to borrow again.'
                  : `${free}% of your limit is still free.`}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
