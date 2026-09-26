'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Receipt, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/home', label: 'Home', icon: Home, match: ['/home', '/products'] },
  { href: '/loans', label: 'My loans', icon: Receipt, match: ['/loans', '/applications'] },
  { href: '/profile', label: 'Profile', icon: UserRound, match: ['/profile'] },
];

/**
 * The borrower's bottom navigation.
 *
 * Three destinations, each with an always-visible label: this is used by people
 * who will not learn what a bare glyph means, on phones held in one hand. The
 * active tab is marked twice over — a tinted pill behind the icon and a rule
 * along the top — so it survives both a bright screen outdoors and a
 * colour-blind reader.
 */
export function BorrowerNav({ openLoans = 0 }: { openLoans?: number }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-border bg-card/95 pt-1 shadow-[0_-4px_20px_-12px_rgba(0,0,0,0.3)] backdrop-blur"
    >
      <ul className="grid grid-cols-3">
        {ITEMS.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
          const badge = href === '/loans' ? openLoans : 0;
          return (
            <li key={href} className="relative">
              {active && <span aria-hidden className="absolute inset-x-6 -top-1 h-0.5 rounded-full bg-primary" />}
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className="flex flex-col items-center gap-0.5 px-2 py-2 text-[11px] font-medium"
              >
                <span
                  className={cn(
                    'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors',
                    active ? 'bg-primary/15' : 'bg-transparent'
                  )}
                >
                  <Icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} />
                  {badge > 0 && (
                    <span className="num absolute right-2 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                      {badge}
                      <span className="sr-only"> open</span>
                    </span>
                  )}
                </span>
                <span className={cn(active ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
