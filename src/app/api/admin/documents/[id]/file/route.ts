import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isGuardFailure, jsonError, requirePermission } from '@/lib/api';
import { readDocument } from '@/lib/documents';
import { createAuditLog } from '@/lib/audit-log';
import { canViewBorrowerDocument } from '@/lib/lending/borrower-documents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Serves a borrower document to staff allowed to see it: bank staff any, a
 * provider's staff their own and the bank's documents of borrowers they deal
 * with. Always as an attachment with the type sniffed at upload — never
 * rendered inline on our origin.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('documents', 'read');
  if (isGuardFailure(guard)) return guard.response;
  const { id } = await params;

  const doc = await prisma.borrowerDocument.findUnique({
    where: { id },
    include: { documentType: { select: { name: true } } },
  });
  if (!doc || !doc.storageName || !doc.mimeType || !(await canViewBorrowerDocument(guard.user, doc))) {
    return jsonError('Document not found.', 404);
  }

  const data = await readDocument(doc.storageName);
  if (!data) return jsonError('Document not found.', 404);

  await createAuditLog({
    actorId: guard.user.id,
    actorName: guard.user.fullName,
    action: 'DOCUMENT_VIEWED',
    entity: 'Borrower',
    entityId: doc.borrowerId,
    details: { documentId: doc.id, documentType: doc.documentType.name, version: doc.version },
  });

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${(doc.fileName ?? 'document').replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
