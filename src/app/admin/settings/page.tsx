import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { CATEGORY_LABELS, getSettings, SETTING_CATEGORIES, SETTING_DEFINITIONS } from '@/lib/settings';
import { activeDevSwitches } from '@/lib/dev-switches';
import { PageHeader } from '@/components/admin/page-header';
import { SettingsForm } from '@/components/admin/settings-form';
import { ActionDialog } from '@/components/admin/action-dialog';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

const taxFields = (defaults?: { name: string; ratePercent: string; appliesToFee: boolean; appliesToInterest: boolean; appliesToPenalty: boolean; status: string }) => [
  { name: 'name', label: 'Name', required: true, defaultValue: defaults?.name ?? '' },
  { name: 'ratePercent', label: 'Rate (%)', type: 'amount' as const, required: true, defaultValue: defaults?.ratePercent ?? '15' },
  { name: 'appliesToFee', label: 'Applies to service fees', type: 'select' as const, defaultValue: String(defaults?.appliesToFee ?? true), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  { name: 'appliesToInterest', label: 'Applies to interest', type: 'select' as const, defaultValue: String(defaults?.appliesToInterest ?? true), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  { name: 'appliesToPenalty', label: 'Applies to penalties', type: 'select' as const, defaultValue: String(defaults?.appliesToPenalty ?? true), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  { name: 'status', label: 'Status', type: 'select' as const, defaultValue: defaults?.status ?? 'ACTIVE', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }] },
];

export default async function SettingsPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const [values, taxes] = await Promise.all([getSettings(true), prisma.taxRule.findMany({ orderBy: { name: 'asc' } })]);
  const canUpdate = hasPermission(user, 'settings', 'update') && !user.providerId;
  const dev = activeDevSwitches();

  return (
    <>
      <PageHeader title="Settings" description="Platform configuration. Secrets and integration endpoints live in the server environment, not here." />

      {dev.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <strong>Development switches are on:</strong> {dev.join(' ')} They are ignored when NODE_ENV is production.
        </div>
      )}

      <section className="panel mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Tax rules</h2>
            <p className="text-xs text-muted-foreground">Snapshotted into each loan at origination — a change here never reprices existing loans. Changes need approval.</p>
          </div>
          {canUpdate && (
            <ActionDialog
              label="New tax"
              title="New tax rule"
              endpoint="/api/admin/settings"
              extra={{ action: 'tax-create' }}
              submitLabel="Send for approval"
              fields={taxFields()}
            />
          )}
        </div>
        <TableCard>
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-secondary/50 text-left">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 text-right font-semibold">Rate</th>
                <th className="px-4 py-2 font-semibold">Applies to</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {taxes.length === 0 && <EmptyRow colSpan={5} message="No taxes configured." />}
              {taxes.map((tax) => (
                <tr key={tax.id}>
                  <td className="px-4 py-2">{tax.name}</td>
                  <td className="num px-4 py-2 text-right">{Number(tax.ratePercent.toString())}%</td>
                  <td className="px-4 py-2 text-xs">
                    {[tax.appliesToFee && 'fees', tax.appliesToInterest && 'interest', tax.appliesToPenalty && 'penalties'].filter(Boolean).join(', ')}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tax.status} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canUpdate && (
                      <ActionDialog
                        label="Edit"
                        variant="ghost"
                        title={`Edit ${tax.name}`}
                        endpoint="/api/admin/settings"
                        extra={{ action: 'tax-update', id: tax.id }}
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
      </section>

      <SettingsForm
        canUpdate={canUpdate}
        approvalOn={Boolean(values['security.requireApprovalForSettings'])}
        values={Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, values[d.key]]))}
        groups={SETTING_CATEGORIES.map((category) => ({
          label: CATEGORY_LABELS[category],
          fields: SETTING_DEFINITIONS.filter((d) => d.category === category).map((d) => ({
            key: d.key,
            label: d.label,
            description: d.description,
            type: d.type,
            sensitive: Boolean(d.sensitive),
            options: d.options,
          })),
        })).filter((g) => g.fields.length)}
      />
    </>
  );
}
