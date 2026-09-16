import prisma from '@/lib/prisma';
import { PageHeader } from '@/components/admin/page-header';
import { RoleBuilder } from '@/components/admin/role-builder';
import { getCurrentUser } from '@/lib/session';
import { expandTabPermissions, hasPermission, parsePermissions } from '@/lib/permissions';
import { allMenuItems, subModuleKey } from '@/lib/menu-items';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Access Control' };

export default async function AccessControlPage() {
  const [user, roles] = await Promise.all([
    getCurrentUser({ allowRefresh: false }),
    prisma.role.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } }),
  ]);

  return (
    <>
      <PageHeader
        title="Access Control"
        description="Roles decide which modules a person can open and what they may do there. Approve is the checker's right: deciding other people's requests. Super Admin always has full access."
      />
      <RoleBuilder
        modules={allMenuItems.map((item) => ({
          key: item.moduleKey,
          label: item.label,
          group: item.group,
          subModules: (item.subModules ?? []).map((sub) => ({ key: subModuleKey(item.moduleKey, sub.tab), label: sub.label })),
        }))}
        roles={roles.map((role) => ({
          id: role.id,
          name: role.name,
          description: role.description ?? '',
          isSystem: role.isSystem,
          userCount: role._count.users,
          permissions: expandTabPermissions(parsePermissions(role.permissions)),
        }))}
        canCreate={hasPermission(user, 'access-control', 'create')}
        canUpdate={hasPermission(user, 'access-control', 'update')}
        canDelete={hasPermission(user, 'access-control', 'delete')}
      />
    </>
  );
}
