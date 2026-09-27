import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, assertProviderAccess, handle, isGuardFailure, jsonError, readJsonBody, requirePermission } from '@/lib/api';
import { requestChange } from '@/lib/approvals';
import { documentTypeUpdateSchema } from '@/lib/lending/catalog';

export const dynamic = 'force-dynamic';

/** Requests a change to a document type. Documents already on file keep their review. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('document-types', 'update');
  if (isGuardFailure(guard)) return guard.response;
  const { user } = guard;

  const body = await readJsonBody<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;

  return handle(async () => {
    const type = await prisma.documentType.findUnique({ where: { id } });
    if (!type) throw new ApiError(404, 'Document type not found.');
    if (type.scope === 'GLOBAL' && user.providerId) {
      return jsonError('Bank documents are changed by bank staff.', 403);
    }
    assertProviderAccess(user, type.providerId, 'Document type');
    const change = await requestChange({
      kind: 'DocumentType.UPDATE',
      entityId: id,
      payload: body,
      previousData: documentTypeUpdateSchema.parse(type),
      summary: `Update document type ${type.name}`,
      user,
    });
    return { ok: true, message: 'Change submitted for approval.', changeId: change.id };
  });
}
