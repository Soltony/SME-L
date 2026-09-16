import Link from 'next/link';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { toCents } from '@/lib/money';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { ProviderForm } from '@/components/admin/provider-form';
import { ProviderBadge } from '@/components/provider-icon';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Providers' };

export default async function ProvidersPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const providers = await prisma.loanProvider.findMany({
    where: user.providerId ? { id: user.providerId } : {},
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { products: true } },
      accounts: { where: { systemKey: { in: ['CASH', 'LOANS_RECEIVABLE'] } }, select: { systemKey: true, balance: true } },
    },
  });
  const canCreate = hasPermission(user, 'providers', 'create') && !user.providerId;

  return (
    <>
      <PageHeader title="Providers" description="Lenders on the platform. Each has its own book of accounts, products and scoring model." />
      <TableCard>
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Provider</th>
              <th className="px-4 py-2.5 font-semibold">Code</th>
              <th className="px-4 py-2.5 text-right font-semibold">Products</th>
              <th className="px-4 py-2.5 text-right font-semibold">Fund cash</th>
              <th className="px-4 py-2.5 text-right font-semibold">Reserved</th>
              <th className="px-4 py-2.5 text-right font-semibold">Loans receivable</th>
              <th className="px-4 py-2.5 font-semibold">NPL after</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {providers.length === 0 && <EmptyRow colSpan={8} message="No providers yet." />}
            {providers.map((p) => {
              const balance = (key: string) => toCents(p.accounts.find((a) => a.systemKey === key)?.balance);
              return (
                <tr key={p.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/providers/${p.id}`} className="flex items-center gap-2 font-medium text-primary hover:underline">
                      <ProviderBadge icon={p.icon} color={p.colorHex} />
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono">{p.code}</td>
                  <td className="num px-4 py-2.5 text-right">{p._count.products}</td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(balance('CASH'), currency)}</td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(p.reservedFunds), currency)}</td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(balance('LOANS_RECEIVABLE'), currency)}</td>
                  <td className="px-4 py-2.5">{p.nplThresholdDays} days</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={p.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>

      {canCreate && (
        <section className="panel mt-6 p-4">
          <h2 className="font-semibold">New provider</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Created once a second person approves it, with its chart of accounts. Fund it from Accounting → Capital.
          </p>
          <ProviderForm canSubmit />
        </section>
      )}
    </>
  );
}
