import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange, settingNeedsApproval } from '@/lib/approvals';
import { createAuditLog } from '@/lib/audit-log';
import { getSettings, setSetting, SETTINGS_BY_KEY, validateSettingValue } from '@/lib/settings';
import { taxRuleSchema } from '@/lib/lending/catalog';

export const dynamic = 'force-dynamic';

/**
 * Settings and tax rules. Sensitive settings (and every tax change) go
 * through maker-checker; the rest apply at once and are audited.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('settings', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  if (user.providerId) return jsonError('Platform settings can only be changed by platform staff.', 403);

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const action = String(body.action || '');

  return handle(async () => {
    if (action === 'settings') {
      const values = (body.values ?? {}) as Record<string, unknown>;
      const current = await getSettings(true);
      const approvalOn = Boolean(current['security.requireApprovalForSettings']);

      const direct: Record<string, string | number | boolean> = {};
      const gated: Record<string, string | number | boolean> = {};
      for (const [key, raw] of Object.entries(values)) {
        if (!SETTINGS_BY_KEY.has(key)) throw new ApiError(400, `Unknown setting ${key}.`);
        const checked = validateSettingValue(key, raw);
        if (!checked.ok) throw new ApiError(400, checked.error, key);
        if (current[key] === checked.value) continue;
        // Turning maker-checker itself off is always gated while it is on.
        if (settingNeedsApproval(key, approvalOn)) gated[key] = checked.value;
        else direct[key] = checked.value;
      }

      for (const [key, value] of Object.entries(direct)) await setSetting(key, value, user.id);
      if (Object.keys(direct).length) {
        await createAuditLog({
          actorId: user.id,
          actorName: user.fullName,
          action: 'SETTINGS_UPDATED',
          entity: 'SystemSetting',
          details: { values: direct, previous: Object.fromEntries(Object.keys(direct).map((k) => [k, current[k]])) },
        });
      }

      let changeId: string | null = null;
      if (Object.keys(gated).length) {
        const change = await requestChange({
          kind: 'Settings.UPDATE',
          payload: gated,
          previousData: Object.fromEntries(Object.keys(gated).map((k) => [k, current[k]])),
          summary: `Change ${Object.keys(gated).map((k) => SETTINGS_BY_KEY.get(k)?.label ?? k).join(', ')}`,
          user,
        });
        changeId = change.id;
      }

      const parts = [];
      if (Object.keys(direct).length) parts.push(`${Object.keys(direct).length} saved`);
      if (changeId) parts.push(`${Object.keys(gated).length} sent for approval`);
      return { ok: true, message: parts.length ? `Settings: ${parts.join(', ')}.` : 'Nothing changed.', changeId };
    }

    if (action === 'tax-create') {
      const change = await requestChange({
        kind: 'TaxRule.CREATE',
        payload: body.tax,
        summary: `Create tax rule ${String((body.tax as { name?: string })?.name ?? '')}`,
        user,
      });
      return { ok: true, message: 'Tax rule submitted for approval. New loans use it once approved.', changeId: change.id };
    }

    if (action === 'tax-update') {
      const id = String(body.id || '');
      const tax = await prisma.taxRule.findUnique({ where: { id } });
      if (!tax) throw new ApiError(404, 'Tax rule not found.');
      const previous = taxRuleSchema.parse({ ...tax, ratePercent: tax.ratePercent.toString() });
      const change = await requestChange({
        kind: 'TaxRule.UPDATE',
        entityId: id,
        payload: body.tax,
        previousData: previous,
        summary: `Update tax rule ${tax.name}`,
        user,
      });
      return { ok: true, message: 'Tax change submitted for approval. Existing loans keep their original tax.', changeId: change.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
