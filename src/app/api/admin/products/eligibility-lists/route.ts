import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, requirePermission } from '@/lib/api';
import { csvResponse } from '@/lib/csv-response';
import { containsMarkup } from '@/lib/plain-text';
import { LIST_TEMPLATE_HEADER, LIST_TEMPLATE_ROWS } from '@/lib/eligibility-list';
import { createEligibilityList, readListUpload } from '@/lib/lending/eligibility-lists';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

/** A template to fill in: a phone column, and an optional name column. */
export async function GET() {
  const guard = await requirePermission('products', 'read');
  if (isGuardFailure(guard)) return guard.response;
  return csvResponse('eligible-customers-template.csv', LIST_TEMPLATE_HEADER, LIST_TEMPLATE_ROWS);
}

/** Creates a saved customer list from an uploaded spreadsheet. */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('products', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  return handle(async () => {
    const { form, fileName, parsed } = await readListUpload(req);

    const providerId = String(form.get('providerId') ?? '');
    assertProviderAccess(user, providerId, 'Provider');
    const provider = await prisma.loanProvider.findUnique({ where: { id: providerId }, select: { id: true } });
    if (!provider) throw new ApiError(404, 'Provider not found.');

    const name = String(form.get('name') ?? '').trim().slice(0, 80);
    if (name.length < 2) throw new ApiError(400, 'Name the list, e.g. "Payroll customers – March".', 'name');
    const description = String(form.get('description') ?? '').trim().slice(0, 300) || null;
    if (containsMarkup(name) || (description && containsMarkup(description))) {
      throw new ApiError(400, 'HTML and script tags are not allowed here.', 'name');
    }

    const { id, summary } = await createEligibilityList({ providerId, name, description, fileName, parsed, actor: user });
    return {
      ok: true,
      id,
      name,
      message: `${name} saved with ${summary.total.toLocaleString('en-US')} customers.`,
      summary,
      rejections: parsed.rejections.slice(0, 100),
    };
  });
}
