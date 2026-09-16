import { NextRequest } from 'next/server';
import { unlink } from 'node:fs/promises';
import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, jsonError, requireBorrower, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import {
  cleanFileName,
  DocumentError,
  MAX_DOCUMENT_BYTES,
  parseRequiredDocuments,
  resolveDocumentPath,
  storeDocument,
} from '@/lib/documents';
import { createAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Uploads one requested document to the borrower's own, still-open application. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('documentUpload', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES + 64_000) {
    return jsonError('The file is larger than 5 MB.', 413);
  }

  const { id } = await params;
  return handle(async () => {
    const application = await prisma.loanApplication.findFirst({
      where: { id, borrowerId: ctx.borrower.id },
      include: { product: { select: { requiredDocuments: true } } },
    });
    if (!application) throw new ApiError(404, 'Application not found.');
    if (application.status !== 'SUBMITTED') {
      throw new ApiError(409, 'Documents can only be added while the application is under review.');
    }

    const form = await req.formData().catch(() => null);
    if (!form) throw new ApiError(400, 'Upload the file as multipart form data.');
    const documentKey = String(form.get('documentKey') || '');
    const file = form.get('file');
    const required = parseRequiredDocuments(application.product.requiredDocuments);
    if (!required.some((d) => d.key === documentKey)) {
      throw new ApiError(400, 'This document is not requested for this product.', 'documentKey');
    }
    if (!(file instanceof File)) throw new ApiError(400, 'Choose a file to upload.', 'file');

    let stored;
    try {
      stored = await storeDocument(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      if (error instanceof DocumentError) throw new ApiError(400, error.message, 'file');
      throw error;
    }

    const previous = await prisma.applicationDocument.findUnique({
      where: { applicationId_documentKey: { applicationId: application.id, documentKey } },
    });
    await prisma.$transaction([
      ...(previous ? [prisma.applicationDocument.delete({ where: { id: previous.id } })] : []),
      prisma.applicationDocument.create({
        data: {
          applicationId: application.id,
          documentKey,
          fileName: cleanFileName(file.name),
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageName: stored.storageName,
        },
      }),
    ]);
    if (previous) {
      const oldPath = resolveDocumentPath(previous.storageName);
      if (oldPath) await unlink(oldPath).catch(() => null);
    }

    await createAuditLog({
      actorId: ctx.borrower.phoneNumber,
      actorType: 'BORROWER',
      action: previous ? 'DOCUMENT_REPLACED' : 'DOCUMENT_UPLOADED',
      entity: 'LoanApplication',
      entityId: application.id,
      details: { documentKey, sha256: stored.sha256, sizeBytes: stored.sizeBytes, mimeType: stored.mimeType },
    });
    return { ok: true, documentKey, fileName: cleanFileName(file.name) };
  });
}
