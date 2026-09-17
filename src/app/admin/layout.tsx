import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { AdminShell } from '@/components/admin/admin-shell';
import { allMenuItems } from '@/lib/menu-items';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { activeDevSwitches } from '@/lib/dev-switches';

export const dynamic = 'force-dynamic';

/** Routes that render their own full-page chrome instead of the console shell. */
const BARE_ROUTES = ['/admin/login', '/admin/change-password'];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const pathname = headerList.get('x-pathname');

  // `x-pathname` is stamped by src/proxy.ts; without it the bare auth screens
  // cannot be told apart, so render bare rather than risk a redirect loop.
  if (!pathname || BARE_ROUTES.some((route) => pathname.startsWith(route))) return <>{children}</>;

  const user = await getCurrentUser({ allowRefresh: false });
  if (!user) redirect('/admin/login');
  if (user.passwordChangeRequired) redirect('/admin/change-password');

  const visibleItems = allMenuItems
    .filter((item) => hasPermission(user, item.moduleKey, 'read'))
    .filter((item) => !item.roles?.length || item.roles.some((role) => role.toLowerCase() === user.role.toLowerCase()))
    .map(({ path, label, moduleKey, group }) => ({ path, label, moduleKey, group }));

  const [pendingApprovals, settings, provider] = await Promise.all([
    hasPermission(user, 'approvals', 'read')
      ? prisma.pendingChange.count({
          where: {
            status: 'PENDING',
            NOT: { createdById: user.id },
            ...(user.providerId ? { providerId: user.providerId } : {}),
          },
        })
      : 0,
    getSettings(),
    user.providerId
      ? prisma.loanProvider.findUnique({ where: { id: user.providerId }, select: { name: true } })
      : null,
  ]);

  return (
    <AdminShell
      user={{
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        providerName: provider?.name ?? null,
      }}
      items={visibleItems}
      pendingApprovals={pendingApprovals}
      brandName={String(settings['platform.name'] || 'SME Lending')}
      brandLogo={String(settings['platform.logo'] || '') || null}
      devWarnings={activeDevSwitches()}
    >
      {children}
    </AdminShell>
  );
}
