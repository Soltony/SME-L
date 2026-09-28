import { cn } from '@/lib/utils';

/**
 * A single-hue bar for one measure — a share or a utilization — shown beside
 * its exact figure. One hue on a shared track, so rows compare by length alone.
 */
export function ShareBar({ share, className }: { share: number; className?: string }) {
  const width = Math.max(0, Math.min(1, share)) * 100;
  return (
    <span className={cn('block h-2 overflow-hidden rounded-full bg-secondary', className)} aria-hidden>
      <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
    </span>
  );
}
