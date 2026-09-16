import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, requirePermission } from '@/lib/api';
import { readDocument } from '@/lib/documents';
import { createAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Serves a borrower document to staff who may read applications, for the
 * provider the application belongs to. Always as an attachment, with the type
 * we sniffed at upload — never rendered inline on our origin.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> }
) {
  const guard = await requirePermission('applications', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { id, documentId } = await params;

  const document = await prisma.applicationDocument.findFirst({
    where: { id: documentId, applicationId: id },
    include: { application: { select: { providerId: true, applicationNo: true } } },
  });
  if (!document || (guard.user.providerId && document.application.providerId !== guard.user.providerId)) {
    return jsonError('Document not found.', 404);
  }

  const data = await readDocument(document.storageName);
  if (!data) return jsonError('Document not found.', 404);

  await createAuditLog({
    actorId: guard.user.id,
    actorName: guard.user.fullName,
    action: 'DOCUMENT_VIEWED',
    entity: 'LoanApplication',
    entityId: id,
    details: { documentKey: document.documentKey, applicationNo: document.application.applicationNo },
  });

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': document.mimeType,
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${document.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
