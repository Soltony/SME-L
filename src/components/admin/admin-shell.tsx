'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound, LogOut, Menu, PanelLeftClose, User, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LogoWordmark } from '@/components/icons';
import { allMenuItems, MENU_GROUP_ORDER, type MenuGroup } from '@/lib/menu-items';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface AdminNavItem {
  path: string;
  label: string;
  moduleKey: string;
  group: MenuGroup;
}

interface Props {
  children: React.ReactNode;
  user: { id: string; fullName: string; email: string; role: string; providerName: string | null };
  items: AdminNavItem[];
  brandName: string;
  devWarnings: string[];
  pendingApprovals: number;
}

const ICONS = new Map(allMenuItems.map((item) => [item.path, item.icon]));

export function AdminShell({ children, user, items, pendingApprovals, brandName, devWarnings }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const logout = async () => {
    await fetch('/api/admin/auth/logout', { method: 'POST' }).catch(() => null);
    router.replace('/admin/login');
    router.refresh();
  };

  const grouped = MENU_GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);

  const isActive = (path: string) =>
    path === '/admin' ? pathname === '/admin' : pathname.startsWith(path);

  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {grouped.map(({ group, items: groupItems }) => (
        <div key={group}>
          {!collapsed && (
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </p>
          )}
          <ul className="space-y-0.5">
            {groupItems.map((item) => {
              const Icon = ICONS.get(item.path);
              const active = isActive(item.path);
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    onClick={() => setMobileOpen(false)}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      collapsed && 'justify-center px-2'
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    {Icon && <Icon className="h-4 w-4 shrink-0" />}
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                    {!collapsed && item.moduleKey === 'approvals' && pendingApprovals > 0 && (
                      <Badge variant={active ? 'secondary' : 'warning'} className="px-1.5 py-0">
                        {pendingApprovals}
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-secondary/30">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] lg:flex',
          collapsed ? 'w-16' : 'w-60'
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-3">
          {!collapsed && <LogoWordmark className="text-base" name={brandName} />}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <PanelLeftClose className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
          </button>
        </div>
        {nav}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative flex h-full w-64 flex-col bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-3">
              <LogoWordmark className="text-base" name={brandName} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1.5 hover:bg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 hover:bg-secondary lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none transition hover:bg-secondary">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                <User className="h-4 w-4" />
              </span>
              <span className="hidden text-left sm:block">
                <span className="block text-xs font-semibold leading-tight">{user.fullName}</span>
                <span className="block text-[11px] leading-tight text-muted-foreground">
                  {user.role}
                  {user.providerName ? ` · ${user.providerName}` : ''}
                </span>
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="font-semibold">{user.fullName}</p>
                <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin/change-password">
                  <KeyRound className="mr-2 h-4 w-4" />
                  Change password
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {devWarnings.length > 0 && (
          <div className="border-b border-warning/40 bg-warning/15 px-4 py-2 text-xs font-medium text-warning-foreground">
            <strong>Test environment:</strong> {devWarnings.join(' ')}
          </div>
        )}
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
