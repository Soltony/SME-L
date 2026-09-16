import Link from 'next/link';
import { Plus } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { productCard } from '@/lib/lending/product-view';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { money } from '@/components/money';
import { ProviderIcon } from '@/components/provider-icon';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products' };

export default async function ProductsPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const products = await prisma.loanProduct.findMany({
    where: user.providerId ? { providerId: user.providerId } : {},
    include: { provider: { select: { name: true, colorHex: true, icon: true } }, _count: { select: { loans: true, tiers: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }],
  });

  return (
    <>
      <PageHeader
        title="Products"
        description="Loan products and their pricing. Every change is approved by a second person and applies to new loans only."
        actions={
          hasPermission(user, 'products', 'create') ? (
            <Button asChild size="sm">
              <Link href="/admin/products/new">
                <Plus className="mr-1.5 h-4 w-4" /> New product
              </Link>
            </Button>
          ) : null
        }
      />
      <TableCard>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Product</th>
              <th className="px-4 py-2.5 font-semibold">Provider</th>
              <th className="px-4 py-2.5 font-semibold">Amount</th>
              <th className="px-4 py-2.5 font-semibold">Term</th>
              <th className="px-4 py-2.5 font-semibold">Fee</th>
              <th className="px-4 py-2.5 font-semibold">Interest</th>
              <th className="px-4 py-2.5 font-semibold">Decision</th>
              <th className="px-4 py-2.5 text-right font-semibold">Loans</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {products.length === 0 && <EmptyRow colSpan={9} message="No products yet." />}
            {products.map((product) => {
              const card = productCard(product);
              return (
                <tr key={product.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/products/${product.id}`} className="font-medium text-primary hover:underline">
                      {product.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{product.code}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon icon={product.provider.icon} color={product.provider.colorHex} className="h-4 w-4" />
                      {product.provider.name}
                    </span>
                  </td>
                  <td className="num px-4 py-2.5 text-xs">
                    {money(card.minAmount, currency)} – {money(card.maxAmount)}
                  </td>
                  <td className="px-4 py-2.5">
                    {card.durationDays} days{card.installmentCount > 1 ? ` · ${card.installmentCount} installments` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-xs">{card.serviceFee}</td>
                  <td className="px-4 py-2.5 text-xs">{card.interest}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {product.requiresReview ? 'Reviewed' : 'Instant'}
                    {product.requiresScoring ? ` · scored (${product._count.tiers} tiers)` : ''}
                  </td>
                  <td className="num px-4 py-2.5 text-right">{product._count.loans}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={product.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
