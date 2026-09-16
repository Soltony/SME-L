import Link from 'next/link';
import { Download, Trash2 } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';
import { listSummaries } from '@/lib/lending/eligibility-lists';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter } from '@/components/admin/filters';
import { ConfirmButton } from '@/components/admin/action-dialog';
import { ImportIntoList, NewEligibilityList } from '@/components/admin/eligibility-lists';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Customer lists' };

export default async function EligibilityListsPage({ searchParams }: { searchParams: Promise<{ providerId?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const providers = await prisma.loanProvider.findMany({
    where: user.providerId ? { id: user.providerId } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const providerId = user.providerId ?? (providers.some((p) => p.id === params.providerId) ? params.providerId! : providers[0]?.id);

  const header = (
    <PageHeader
      title="Customer lists"
      breadcrumbs={[{ label: 'Products', href: '/admin/products' }, { label: 'Customer lists' }]}
      description="Upload a spreadsheet of eligible customers once, then choose it on any product. A product with a list lends only to the people on it."
    />
  );
  if (!providerId) {
    return (
      <>
        {header}
        <div className="panel p-6 text-sm text-muted-foreground">Create a provider first.</div>
      </>
    );
  }

  const [lists, products] = await Promise.all([
    listSummaries({ providerId }),
    prisma.loanProduct.findMany({
      where: { providerId, eligibilityListId: { not: null } },
      select: { id: true, name: true, eligibilityListId: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const canCreate = hasPermission(user, 'products', 'create');
  const canUpdate = hasPermission(user, 'products', 'update');
  const canDelete = hasPermission(user, 'products', 'delete');

  return (
    <>
      {header}
      {!user.providerId && providers.length > 1 && (
        <FilterBar>
          <SelectFilter name="providerId" label="Provider" value={providerId} allLabel="Choose…" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          <FilterSubmit />
        </FilterBar>
      )}

      {canCreate && (
        <section className="panel mb-6 p-4">
          <h2 className="font-semibold">New list</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Any sheet with a phone column works — extra columns are ignored. Numbers can be written 0911223344, 911223344 or 251911223344.
          </p>
          <NewEligibilityList providerId={providerId} />
        </section>
      )}

      <TableCard>
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">List</th>
              <th className="px-4 py-2.5 text-right font-semibold">Customers</th>
              <th className="px-4 py-2.5 font-semibold">Used by</th>
              <th className="px-4 py-2.5 font-semibold">Last upload</th>
              <th className="px-4 py-2.5 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lists.length === 0 && <EmptyRow colSpan={5} message="No customer lists yet." />}
            {lists.map((list) => {
              const usedBy = products.filter((p) => p.eligibilityListId === list.id);
              return (
                <tr key={list.id} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{list.name}</p>
                    {list.fileName && <p className="text-xs text-muted-foreground">{list.fileName}</p>}
                  </td>
                  <td className="num px-4 py-3 text-right">{list.entryCount.toLocaleString('en-US')}</td>
                  <td className="px-4 py-3">
                    {usedBy.length === 0 ? (
                      <span className="text-muted-foreground">No products</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {usedBy.map((p) => (
                          <li key={p.id}>
                            <Link href={`/admin/products/${p.id}`} className="text-primary hover:underline">
                              {p.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateTime(list.updatedAt)}
                    {list.updatedBy && <span className="block">by {list.updatedBy}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-start gap-2">
                      {canUpdate && <ImportIntoList listId={list.id} listName={list.name} productCount={usedBy.length} />}
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/admin/products/eligibility-lists/${list.id}`}>
                          <Download className="mr-1.5 h-3.5 w-3.5" /> Download
                        </a>
                      </Button>
                      {canDelete && usedBy.length === 0 && (
                        <ConfirmButton
                          label="Delete"
                          icon={<Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                          confirm={`Delete ${list.name} and its ${list.entryCount} customers?`}
                          endpoint={`/api/admin/products/eligibility-lists/${list.id}`}
                          body={{ action: 'delete' }}
                        />
                      )}
                    </div>
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
