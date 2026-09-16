import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import { csvResponse } from '@/lib/csv-response';
import { toLocalPhone } from '@/lib/format';
import { deleteEligibilityList, importIntoEligibilityList, readListUpload } from '@/lib/lending/eligibility-lists';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

async function findList(listId: string, user: { providerId: string | null }) {
  const list = await prisma.eligibilityList.findUnique({ where: { id: listId }, select: { id: true, name: true, providerId: true } });
  if (!list) throw new ApiError(404, 'List not found.');
  assertProviderAccess(user, list.providerId, 'List');
  return list;
}

/** The customers on the list, as a CSV that uploads straight back in. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ listId: string }> }) {
  const guard = await requirePermission('products', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { listId } = await params;

  return handle(async () => {
    const list = await findList(listId, guard.user);
    const entries = await prisma.eligibilityListEntry.findMany({
      where: { listId },
      orderBy: { createdAt: 'asc' },
      select: { phoneNumber: true, fullName: true },
    });
    return csvResponse(
      `${list.name}.csv`,
      ['phone', 'name'],
      entries.map((e) => [toLocalPhone(e.phoneNumber), e.fullName ?? ''])
    );
  });
}

/**
 * A spreadsheet upload (multipart, with `mode` replace | append) loads new
 * customers into the list; a JSON `{ action: 'delete' }` removes the list.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ listId: string }> }) {
  const guard = await requirePermission('products', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;
  const { listId } = await params;

  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (body instanceof NextResponse) return body;
    return handle(async () => {
      if (body.action !== 'delete') return jsonError('Unknown action.', 400);
      if (!hasPermission(user, 'products', 'delete')) return jsonError('You do not have permission to delete lists.', 403);
      const list = await findList(listId, user);
      await deleteEligibilityList(list.id, user);
      return { ok: true, message: `${list.name} deleted.` };
    });
  }

  return handle(async () => {
    const list = await findList(listId, user);
    const { form, fileName, parsed } = await readListUpload(req);
    const mode = form.get('mode') === 'append' ? 'append' : 'replace';
    const summary = await importIntoEligibilityList({ listId: list.id, mode, fileName, parsed, actor: user });
    const parts = [
      `${summary.added.toLocaleString('en-US')} added`,
      mode === 'replace' && `${summary.removed.toLocaleString('en-US')} removed`,
      `${summary.total.toLocaleString('en-US')} on the list now`,
    ].filter(Boolean);
    return { ok: true, message: `${list.name}: ${parts.join(', ')}.`, summary, rejections: parsed.rejections.slice(0, 100) };
  });
}
