import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { PageHeader } from '@/components/admin/page-header';
import { ActionDialog } from '@/components/admin/action-dialog';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Taxes' };

const yesNo = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const taxFields = (defaults?: { name: string; ratePercent: string; appliesToFee: boolean; appliesToInterest: boolean; appliesToPenalty: boolean; status: string }) => [
  { name: 'name', label: 'Name', required: true, defaultValue: defaults?.name ?? '' },
  { name: 'ratePercent', label: 'Rate (%)', type: 'amount' as const, required: true, defaultValue: defaults?.ratePercent ?? '15' },
  { name: 'appliesToFee', label: 'Applies to service fees', type: 'select' as const, defaultValue: String(defaults?.appliesToFee ?? true), options: yesNo },
  { name: 'appliesToInterest', label: 'Applies to interest', type: 'select' as const, defaultValue: String(defaults?.appliesToInterest ?? true), options: yesNo },
  { name: 'appliesToPenalty', label: 'Applies to penalties', type: 'select' as const, defaultValue: String(defaults?.appliesToPenalty ?? true), options: yesNo },
  {
    name: 'status',
    label: 'Status',
    type: 'select' as const,
    defaultValue: defaults?.status ?? 'ACTIVE',
    options: [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'INACTIVE', label: 'Inactive' },
    ],
  },
];

export default async function TaxesPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const [taxes, pending] = await Promise.all([
    prisma.taxRule.findMany({ orderBy: { name: 'asc' } }),
    prisma.pendingChange.count({ where: { entityType: 'TaxRule', status: 'PENDING' } }),
  ]);
  // Taxes apply to every provider's loans, so only platform staff change them.
  const canCreate = hasPermission(user, 'taxes', 'create') && !user.providerId;
  const canUpdate = hasPermission(user, 'taxes', 'update') && !user.providerId;

  return (
    <>
      <PageHeader
        title="Taxes"
        description="Charged on fees, interest and penalties. Snapshotted into each loan at origination — a change here never reprices existing loans. Changes need approval."
        actions={
          canCreate ? (
            <ActionDialog label="New tax" title="New tax rule" endpoint="/api/admin/taxes" submitLabel="Send for approval" fields={taxFields()} />
          ) : null
        }
      />

      {pending > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          {pending === 1 ? 'A tax change is' : `${pending} tax changes are`} waiting for approval.
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 text-right font-semibold">Rate</th>
              <th className="px-4 py-2.5 font-semibold">Applies to</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {taxes.length === 0 && <EmptyRow colSpan={5} message="No taxes configured." />}
            {taxes.map((tax) => (
              <tr key={tax.id}>
                <td className="px-4 py-2.5">{tax.name}</td>
                <td className="num px-4 py-2.5 text-right">{Number(tax.ratePercent.toString())}%</td>
                <td className="px-4 py-2.5 text-xs">
                  {[tax.appliesToFee && 'fees', tax.appliesToInterest && 'interest', tax.appliesToPenalty && 'penalties'].filter(Boolean).join(', ')}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={tax.status} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  {canUpdate && (
                    <ActionDialog
                      label="Edit"
                      variant="ghost"
                      title={`Edit ${tax.name}`}
                      endpoint={`/api/admin/taxes/${tax.id}`}
                      submitLabel="Send for approval"
                      fields={taxFields({
                        name: tax.name,
                        ratePercent: tax.ratePercent.toString(),
                        appliesToFee: tax.appliesToFee,
                        appliesToInterest: tax.appliesToInterest,
                        appliesToPenalty: tax.appliesToPenalty,
                        status: tax.status,
                      })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
