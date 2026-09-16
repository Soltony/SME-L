import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { PageHeader } from '@/components/admin/page-header';
import { ProductForm } from '@/components/admin/product-form';
import { blankProduct } from '@/components/admin/product-form-values';
import { listSummaries } from '@/lib/lending/eligibility-lists';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New product' };

export default async function NewProductPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  if (!hasPermission(user, 'products', 'create')) notFound();
  const providers = await prisma.loanProvider.findMany({
    where: user.providerId ? { id: user.providerId } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return (
    <>
      <PageHeader
        title="New product"
        breadcrumbs={[{ label: 'Products', href: '/admin/products' }, { label: 'New' }]}
        description="Created as a draft once approved. Add amount tiers, then activate it."
      />
      {providers.length === 0 ? (
        <div className="panel p-6 text-sm text-muted-foreground">Create a provider first.</div>
      ) : (
        <ProductForm
          initial={blankProduct(providers[0].id)}
          providers={providers}
          lists={await listSummaries({ providerId: { in: providers.map((p) => p.id) } })}
          canCreateList
          canSubmit
        />
      )}
    </>
  );
}
