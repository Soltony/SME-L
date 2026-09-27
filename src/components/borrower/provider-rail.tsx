'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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

/** How far a lender may shrink and fade at the edges of the rail. */
const MIN_SCALE = 0.72;
const MIN_OPACITY = 0.35;
/** A swipe has finished once the rail has been still this long. */
const SETTLE_MS = 140;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The lenders a borrower can switch between, as a sliding carousel.
 *
 * The selected lender always sits in the middle at full size; the others
 * shrink and fade with their distance from it, so the row reads as one strip
 * moving past a fixed point rather than a list to scan. Swiping stops with a
 * lender in the middle and that lender is selected; tapping one slides it to
 * the middle. Each provider keeps its own colour, so the borrower learns to
 * recognise their lender by its mark rather than by reading a dropdown.
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
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  items.current.length = providers.length;
  const frame = useRef<number | null>(null);
  const settle = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  // A slide we started ourselves (centring a tapped lender) is not a swipe to read back.
  const steering = useRef(false);

  const selectedIndex = Math.max(0, providers.findIndex((p) => p.id === selectedId));

  /** Scales and fades every lender by its distance from the middle of the rail. */
  const paint = useCallback(() => {
    frame.current = null;
    const el = rail.current;
    if (!el) return;
    const middle = el.scrollLeft + el.clientWidth / 2;
    for (const item of items.current) {
      if (!item) continue;
      const distance = Math.abs(item.offsetLeft + item.offsetWidth / 2 - middle) / item.offsetWidth;
      item.style.transform = `scale(${Math.max(MIN_SCALE, 1 - distance * 0.16)})`;
      item.style.opacity = String(Math.max(MIN_OPACITY, 1 - distance * 0.3));
    }
  }, []);

  const nearestToMiddle = useCallback(() => {
    const el = rail.current;
    if (!el) return null;
    const middle = el.scrollLeft + el.clientWidth / 2;
    let best: number | null = null;
    let bestDistance = Infinity;
    items.current.forEach((item, index) => {
      if (!item) return;
      const distance = Math.abs(item.offsetLeft + item.offsetWidth / 2 - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }, []);

  const centre = useCallback((index: number, animate: boolean) => {
    const el = rail.current;
    const item = items.current[index];
    if (!el || !item) return;
    const left = item.offsetLeft + item.offsetWidth / 2 - el.clientWidth / 2;
    if (Math.abs(el.scrollLeft - left) < 1) return;
    steering.current = true;
    el.scrollTo({ left, behavior: animate && !prefersReducedMotion() ? 'smooth' : 'instant' });
  }, []);

  // The selected lender is always in the middle: placed there on first paint, slid there after.
  useLayoutEffect(() => {
    centre(selectedIndex, mounted.current);
    mounted.current = true;
    paint();
  }, [selectedIndex, providers.length, centre, paint]);

  useEffect(() => {
    const onResize = () => {
      centre(selectedIndex, false);
      paint();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [selectedIndex, centre, paint]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      window.clearTimeout(settle.current);
    },
    []
  );

  const onScroll = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(paint);
    window.clearTimeout(settle.current);
    // Snapping keeps the rail moving after the finger lifts; decide once it is still.
    settle.current = window.setTimeout(() => {
      if (steering.current) {
        steering.current = false;
        return;
      }
      const index = nearestToMiddle();
      if (index !== null && providers[index] && providers[index].id !== selectedId) onSelect(providers[index].id);
    }, SETTLE_MS);
  };

  // A finger or wheel takes over from any slide we started.
  const takeOver = () => {
    steering.current = false;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = providers[selectedIndex + step];
    if (!step || !next) return;
    event.preventDefault();
    onSelect(next.id);
    items.current[selectedIndex + step]?.focus({ preventScroll: true });
  };

  if (providers.length === 0) return null;

  return (
    <div
      ref={rail}
      role="tablist"
      aria-label="Lenders"
      onScroll={onScroll}
      onPointerDown={takeOver}
      onTouchStart={takeOver}
      onWheel={takeOver}
      onKeyDown={onKeyDown}
      className="no-scrollbar rail-fade relative -mx-4 flex snap-x snap-mandatory overflow-x-auto pb-1"
    >
      {/* Room either side, so the first and last lenders can reach the middle too. */}
      <span aria-hidden className="shrink-0" style={{ width: 'calc(50% - 2.75rem)' }} />
      {providers.map((provider, index) => {
        const color = normalizeHex(provider.colorHex);
        const active = provider.id === selectedId;
        return (
          <button
            key={provider.id}
            ref={(el) => {
              items.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-selected={active}
            onClick={() => onSelect(provider.id)}
            className="flex w-[5.5rem] shrink-0 snap-center flex-col items-center gap-1.5 rounded-2xl py-2 outline-none will-change-transform focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'relative flex h-[3.85rem] w-[3.85rem] items-center justify-center rounded-full border-2 transition-colors duration-200',
                !active && 'border-transparent'
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
      <span aria-hidden className="shrink-0" style={{ width: 'calc(50% - 2.75rem)' }} />
    </div>
  );
}
