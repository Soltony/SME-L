'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Receipt, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/home', label: 'Home', icon: Home, match: ['/home', '/products', '/applications'] },
  { href: '/loans', label: 'My loans', icon: Receipt, match: ['/loans'] },
  { href: '/profile', label: 'Profile', icon: UserRound, match: ['/profile'] },
];

export function BorrowerNav() {
  const pathname = usePathname();
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-border bg-card/95 backdrop-blur">
      <ul className="grid grid-cols-3">
        {ITEMS.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
          return (
            <li key={href}>
              <Link
                href={href}
                className={cn('flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className={cn('h-5 w-5', active && 'text-primary')} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
