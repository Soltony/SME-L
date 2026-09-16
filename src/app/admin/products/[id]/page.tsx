import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { productFormValues } from '@/lib/lending/catalog';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { ProductForm } from '@/components/admin/product-form';
import type { ProductFormValues } from '@/components/admin/product-form-values';
import { LoanCalculator, TierEditor } from '@/components/admin/product-tools';
import { ConfirmButton } from '@/components/admin/action-dialog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Product' };

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const product = await prisma.loanProduct.findUnique({
    where: { id },
    include: { provider: { select: { id: true, name: true } }, tiers: { orderBy: { minScore: 'asc' } } },
  });
  if (!product || (user.providerId && product.providerId !== user.providerId)) notFound();

  const values = productFormValues(product);
  const initial: ProductFormValues = {
    providerId: values.providerId,
    code: values.code,
    name: values.name,
    description: values.description,
    minAmount: values.minAmount,
    maxAmount: values.maxAmount,
    durationDays: String(values.durationDays),
    installmentCount: String(values.installmentCount),
    serviceFeeType: values.serviceFeeType,
    serviceFeeValue: values.serviceFeeValue,
    interestType: values.interestType,
    interestValue: values.interestValue,
    interestBasis: values.interestBasis,
    accrueInterestAfterMaturity: values.accrueInterestAfterMaturity,
    penaltyRules: values.penaltyRules.map((r) => ({
      fromDay: String(r.fromDay),
      toDay: r.toDay === null ? '' : String(r.toDay),
      type: r.type,
      value: r.value,
      frequency: r.frequency,
    })),
    allowConcurrentLoans: values.allowConcurrentLoans,
    requiresReview: values.requiresReview,
    requiresScoring: values.requiresScoring,
    requiredDocuments: values.requiredDocuments,
    eligibilityFilter: Object.entries(values.eligibilityFilter ?? {}).map(([field, v]) => ({ field, values: v })),
    cycleEnabled: Boolean(values.cycleConfig),
    cycleMetric: values.cycleConfig?.metric ?? 'PAID_OFF_LOANS',
    cycleSteps: (values.cycleConfig?.steps ?? [{ minCount: 0, percent: 50 }]).map((s) => ({ minCount: String(s.minCount), percent: String(s.percent) })),
  };
  const canUpdate = hasPermission(user, 'products', 'update');

  return (
    <>
      <PageHeader
        title={product.name}
        breadcrumbs={[{ label: 'Products', href: '/admin/products' }, { label: product.name }]}
        description={`${product.provider.name} · ${product.code}`}
        actions={
          <>
            <StatusBadge status={product.status} />
            {canUpdate && product.status !== 'ACTIVE' && (
              <ConfirmButton
                label="Activate"
                confirm="Request activation? Borrowers can apply once it is approved."
                endpoint={`/api/admin/products/${product.id}`}
                body={{ action: 'status', status: 'ACTIVE' }}
              />
            )}
            {canUpdate && product.status === 'ACTIVE' && (
              <ConfirmButton
                label="Deactivate"
                confirm="Request deactivation? Existing loans are unaffected; no new applications are accepted once approved."
                endpoint={`/api/admin/products/${product.id}`}
                body={{ action: 'status', status: 'INACTIVE' }}
              />
            )}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <ProductForm productId={product.id} initial={initial} providers={[product.provider]} canSubmit={canUpdate} />
        <div className="space-y-4">
          <section className="panel p-4">
            <h2 className="mb-1 font-semibold">Calculator</h2>
            <p className="mb-3 text-xs text-muted-foreground">Uses the product as it is stored now, with active taxes.</p>
            <LoanCalculator endpoint={`/api/admin/products/${product.id}`} extra={{ action: 'quote' }} defaultAmount={values.maxAmount} />
          </section>
          <section className="panel p-4">
            <h2 className="mb-1 font-semibold">Amount tiers</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {product.requiresScoring
                ? 'The most a borrower may take for their score. Ranges must not overlap; a score outside every tier cannot borrow.'
                : 'Scoring is off for this product, so tiers are not used.'}
            </p>
            <TierEditor
              productId={product.id}
              canSubmit={canUpdate}
              initial={product.tiers.map((t) => ({ minScore: String(t.minScore), maxScore: String(t.maxScore), maxAmount: t.maxAmount.toString() }))}
            />
          </section>
        </div>
      </div>
    </>
  );
}
