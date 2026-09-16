import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import { requestChange } from '@/lib/approvals';
import { createAuditLog } from '@/lib/audit-log';
import { dataConfigSchema } from '@/lib/data-provisioning';
import { getBorrowerFeatures } from '@/lib/lending/eligibility';
import { scoreBorrower, scoringModelSchema, type ScoringOperator } from '@/lib/lending/scoring';
import { parseEthiopianMobile } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Scoring model changes (need approval), data set definitions, and a score
 * preview that shows exactly which rule each parameter matched.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const guard = await requirePermission('credit-scoring', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { providerId } = await params;
  const action = String(body.action || '');

  return handle(async () => {
    assertProviderAccess(user, providerId, 'Provider');
    const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { id: true, name: true } });
    if (!provider) throw new ApiError(404, 'Provider not found.');

    if (action === 'preview') {
      const parameters = action === 'preview' && Array.isArray(body.parameters)
        ? scoringModelSchema.parse(body.parameters)
        : (
            await prisma.scoringParameter.findMany({
              where: { providerId },
              orderBy: { sortOrder: 'asc' },
              include: { rules: true },
            })
          ).map((p) => ({
            name: p.name,
            weight: p.weight,
            rules: p.rules.map((r) => ({ field: r.field, operator: r.operator as ScoringOperator, value: r.value, score: r.score })),
          }));

      let values: Record<string, unknown> = {};
      if (body.phone) {
        const phone = parseEthiopianMobile(String(body.phone));
        if (!phone) return jsonError('Enter a valid phone number.', 400, { field: 'phone' });
        const borrower = await prisma.borrower.findUnique({ where: { phoneNumber: phone } });
        const features = await getBorrowerFeatures(prisma, { id: borrower?.id ?? '__none__', phoneNumber: phone }, providerId);
        values = features.values;
      } else if (body.values && typeof body.values === 'object') {
        values = body.values as Record<string, unknown>;
      }
      return { ...scoreBorrower(parameters, values), values };
    }

    if (action === 'save-model') {
      if (!hasPermission(user, 'credit-scoring', 'update')) return jsonError('You do not have permission to change scoring.', 403);
      const existing = await prisma.scoringParameter.findMany({
        where: { providerId },
        orderBy: { sortOrder: 'asc' },
        include: { rules: { select: { field: true, operator: true, value: true, score: true } } },
      });
      const change = await requestChange({
        kind: 'ScoringModel.UPDATE',
        entityId: providerId,
        payload: { parameters: body.parameters },
        previousData: { parameters: existing.map((p) => ({ name: p.name, weight: p.weight, rules: p.rules })) },
        summary: `Replace the scoring model for ${provider.name}`,
        user,
      });
      return { ok: true, message: 'Scoring model submitted for approval.', changeId: change.id };
    }

    if (action === 'create-config') {
      if (!hasPermission(user, 'credit-scoring', 'create')) return jsonError('You do not have permission to define data sets.', 403);
      const input = dataConfigSchema.parse({ name: body.name, columns: body.columns });
      const clash = await prisma.dataProvisioningConfig.findUnique({
        where: { providerId_name: { providerId, name: input.name } },
      });
      if (clash) throw new ApiError(409, 'A data set with this name already exists.', 'name');
      const config = await prisma.dataProvisioningConfig.create({
        data: { providerId, name: input.name, columns: JSON.stringify(input.columns) },
      });
      await createAuditLog({
        actorId: user.id,
        actorName: user.fullName,
        action: 'DATA_CONFIG_CREATED',
        entity: 'DataProvisioningConfig',
        entityId: config.id,
        details: input,
      });
      return { ok: true, message: 'Data set created.', id: config.id };
    }

    return jsonError('Unknown action.', 400);
  });
}
