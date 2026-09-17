import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { CATEGORY_LABELS, getSettings, SETTING_CATEGORIES, SETTING_DEFINITIONS } from '@/lib/settings';
import { activeDevSwitches } from '@/lib/dev-switches';
import { PageHeader } from '@/components/admin/page-header';
import { SettingsForm } from '@/components/admin/settings-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const values = await getSettings(true);
  const canUpdate = hasPermission(user, 'settings', 'update') && !user.providerId;
  const dev = activeDevSwitches();

  return (
    <>
      <PageHeader title="Settings" description="Platform configuration. Tax rules are under Taxes; secrets and integration endpoints live in the server environment, not here." />

      {dev.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <strong>Development switches are on:</strong> {dev.join(' ')} They are ignored when NODE_ENV is production.
        </div>
      )}

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
            unit: d.unit,
            min: d.min,
            max: d.max,
            options: d.options,
          })),
        })).filter((g) => g.fields.length)}
      />
    </>
  );
}
