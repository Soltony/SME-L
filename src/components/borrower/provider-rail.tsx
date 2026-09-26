'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { alpha, normalizeHex } from '@/lib/brand';
import { ProviderIcon } from '@/components/provider-icon';

export interface RailProvider {
  id: string;
  name: string;
  colorHex: string;
  icon: string;
  /** Open loans with this lender — shown as a count on the mark. */
  openLoans: number;
}

/**
 * The lenders a borrower can switch between, as a row of marks.
 *
 * Each provider keeps its own colour, so the ring and the name are the only
 * things that move as the selection changes: the borrower learns to recognise
 * their lender by its mark rather than by reading a dropdown. The selected mark
 * is scrolled into view, which matters on a phone once there are more lenders
 * than fit across the screen.
 */
export function ProviderRail({
  providers,
  selectedId,
  onSelect,
}: {
  providers: RailProvider[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rail.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selectedId]);

  if (providers.length === 0) return null;

  return (
    <div
      ref={rail}
      role="tablist"
      aria-label="Lenders"
      className={cn(
        'no-scrollbar -mx-4 flex gap-1 overflow-x-auto scroll-smooth px-4 pb-1',
        providers.length > 3 ? 'rail-fade justify-start' : 'justify-center'
      )}
    >
      {providers.map((provider) => {
        const color = normalizeHex(provider.colorHex);
        const active = provider.id === selectedId;
        return (
          <button
            key={provider.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-selected={active}
            onClick={() => onSelect(provider.id)}
            className="flex w-[5.5rem] shrink-0 flex-col items-center gap-1.5 rounded-2xl py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'relative flex h-[3.85rem] w-[3.85rem] items-center justify-center rounded-full border-2 transition-all duration-200',
                active ? 'scale-100' : 'scale-95 border-transparent'
              )}
              style={active ? { borderColor: color, backgroundColor: alpha(color, 0.1) } : undefined}
            >
              <span
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full bg-card transition-shadow',
                  active ? 'shadow-md' : 'shadow-sm'
                )}
              >
                <ProviderIcon
                  icon={provider.icon}
                  color={active ? color : undefined}
                  className={cn('h-6 w-6', !active && 'text-muted-foreground opacity-70')}
                />
              </span>
              {provider.openLoans > 0 && (
                <span
                  className="num absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-background px-1 text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {provider.openLoans}
                  <span className="sr-only"> open loan(s)</span>
                </span>
              )}
            </span>
            <span
              className={cn('line-clamp-2 text-center text-[11px] leading-tight', active ? 'font-semibold' : 'text-muted-foreground')}
              style={active ? { color } : undefined}
            >
              {provider.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
