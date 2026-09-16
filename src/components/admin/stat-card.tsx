import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  href,
  active = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'destructive';
  /** Turns the card into a link — used for cards that double as filter shortcuts. */
  href?: string;
  /** Highlights a linked card whose filter is currently applied. */
  active?: boolean;
}) {
  const tones: Record<string, string> = {
    default: 'text-foreground',
    primary: 'text-primary',
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  };

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className={cn('h-4 w-4', tones[tone])} />}
      </div>
      <p className={cn('mt-2 text-2xl font-bold tabular-nums', tones[tone])}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </>
  );

  const className = cn(
    'block rounded-xl border bg-card p-4',
    href && 'transition hover:border-primary/60 hover:bg-secondary/40',
    active ? 'border-primary ring-1 ring-primary' : 'border-border'
  );

  if (!href) return <div className={className}>{body}</div>;

  return (
    <Link href={href} className={className} aria-current={active ? 'true' : undefined}>
      {body}
    </Link>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{children}</div>
  );
}
