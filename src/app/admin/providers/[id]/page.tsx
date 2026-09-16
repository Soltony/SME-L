import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { formatDateTime } from '@/lib/format';
import { fundPosition } from '@/lib/lending/loan-service';
import { providerFormValues } from '@/lib/lending/catalog';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { ProviderForm } from '@/components/admin/provider-form';
import { ActionDialog } from '@/components/admin/action-dialog';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Provider' };

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  if (user.providerId && user.providerId !== id) notFound();

  const provider = await prisma.loanProvider.findUnique({
    where: { id },
    include: {
      products: { orderBy: { name: 'asc' }, select: { id: true, name: true, code: true, status: true } },
      terms: { orderBy: { version: 'desc' }, take: 5 },
    },
  });
  if (!provider) notFound();

  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const funds = await fundPosition(prisma, id);
  const canUpdate = hasPermission(user, 'providers', 'update');
  const activeTerms = provider.terms.find((t) => t.isActive);

  return (
    <>
      <PageHeader
        title={provider.name}
        breadcrumbs={[{ label: 'Providers', href: '/admin/providers' }, { label: provider.name }]}
        description={`Code ${provider.code}`}
        actions={<StatusBadge status={provider.status} />}
      />

      <StatGrid>
        <StatCard label="Fund cash" value={moneyCents(funds.cash, currency)} />
        <StatCard label="Reserved for disbursement" value={moneyCents(funds.reserved, currency)} />
        <StatCard label="Available to lend" value={moneyCents(funds.available, currency)} tone="primary" />
        <StatCard label="Products" value={provider.products.length} href="/admin/products" />
      </StatGrid>

      <section className="panel mt-6 p-4">
        <h2 className="mb-4 font-semibold">Details</h2>
        <ProviderForm providerId={provider.id} initial={providerFormValues(provider)} canSubmit={canUpdate} />
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="panel p-4 text-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Terms &amp; conditions</h2>
            {canUpdate && (
              <ActionDialog
                label="Publish new version"
                title="Publish terms & conditions"
                description="Borrowers must accept the new version on their next application. Needs approval."
                endpoint={`/api/admin/providers/${provider.id}`}
                extra={{ action: 'publish-terms' }}
                submitLabel="Send for approval"
                fields={[{ name: 'content', label: 'Terms', type: 'textarea', required: true, defaultValue: activeTerms?.content ?? '' }]}
              />
            )}
          </div>
          {activeTerms ? (
            <>
              <p className="text-xs text-muted-foreground">
                Version {activeTerms.version}, published {formatDateTime(activeTerms.publishedAt)}
              </p>
              <p className="mt-2 whitespace-pre-wrap rounded-md bg-secondary/50 p-3">{activeTerms.content}</p>
            </>
          ) : (
            <p className="text-muted-foreground">No terms published. Borrowers are not asked to accept any.</p>
          )}
        </section>
        <section className="panel p-4 text-sm">
          <h2 className="mb-3 font-semibold">Products</h2>
          <ul className="divide-y divide-border">
            {provider.products.length === 0 && <li className="py-2 text-muted-foreground">No products yet.</li>}
            {provider.products.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <Link href={`/admin/products/${p.id}`} className="text-primary hover:underline">
                  {p.name} <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                </Link>
                <StatusBadge status={p.status} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
