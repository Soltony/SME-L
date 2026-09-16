import { cn } from '@/lib/utils';

/** A currency amount in tabular figures. `value` is in currency units, already exact. */
export function Money({
  value,
  currency,
  className,
  muted = false,
}: {
  value: number;
  currency?: string;
  className?: string;
  muted?: boolean;
}) {
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <span className={cn('num whitespace-nowrap', muted && value === 0 && 'text-muted-foreground', className)}>
      {currency ? <span className="mr-1 text-[0.8em] text-muted-foreground">{currency}</span> : null}
      {text}
    </span>
  );
}

export function money(value: number, currency?: string) {
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${text}` : text;
}

/** Cents to display string, for server components holding integer amounts. */
export function moneyCents(cents: number, currency?: string) {
  return money(cents / 100, currency);
}
