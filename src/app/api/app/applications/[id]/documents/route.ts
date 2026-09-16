import { NextRequest, NextResponse } from 'next/server';
import { unlink } from 'node:fs/promises';
import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, jsonError, readJsonBody, requireBorrower, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import {
  cleanFileName,
  DocumentError,
  MAX_ANSWER_LENGTH,
  MAX_DOCUMENT_BYTES,
  parseRequiredDocuments,
  resolveDocumentPath,
  storeDocument,
} from '@/lib/documents';
import { createAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Provides one requested document for the borrower's own, still-open
 * application: a file as multipart form data, or — for a document the product
 * asks to be typed — `{ documentKey, value }` as JSON.
 */
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
  const isFile = (req.headers.get('content-type') ?? '').includes('multipart/form-data');
  // Read before `handle`, so a body carrying markup is refused the standard way.
  const json = isFile ? null : await readJsonBody<Record<string, unknown>>(req);
  if (json instanceof NextResponse) return json;

  return handle(async () => {
    const application = await prisma.loanApplication.findFirst({
      where: { id, borrowerId: ctx.borrower.id },
      include: { product: { select: { requiredDocuments: true } } },
    });
    if (!application) throw new ApiError(404, 'Application not found.');
    if (application.status !== 'SUBMITTED') {
      throw new ApiError(409, 'Documents can only be added while the application is under review.');
    }

    const form = isFile ? await req.formData().catch(() => null) : null;
    if (isFile && !form) throw new ApiError(400, 'Upload the file as multipart form data.');
    const documentKey = String((isFile ? form?.get('documentKey') : json?.documentKey) || '');
    const requested = parseRequiredDocuments(application.product.requiredDocuments).find((d) => d.key === documentKey);
    if (!requested) throw new ApiError(400, 'This document is not requested for this product.', 'documentKey');

    if (requested.type === 'TEXT') {
      if (isFile) throw new ApiError(400, `${requested.name} is typed in, not uploaded.`, 'file');
      const value = String(json?.value ?? '').trim();
      if (!value) throw new ApiError(400, `Enter your ${requested.name}.`, 'value');
      if (value.length > MAX_ANSWER_LENGTH) throw new ApiError(400, `Keep it under ${MAX_ANSWER_LENGTH} characters.`, 'value');

      const previous = await prisma.applicationAnswer.findUnique({
        where: { applicationId_documentKey: { applicationId: application.id, documentKey } },
        select: { id: true },
      });
      await prisma.applicationAnswer.upsert({
        where: { applicationId_documentKey: { applicationId: application.id, documentKey } },
        create: { applicationId: application.id, documentKey, value },
        update: { value, answeredAt: new Date() },
      });
      await createAuditLog({
        actorId: ctx.borrower.phoneNumber,
        actorType: 'BORROWER',
        action: previous ? 'ANSWER_REPLACED' : 'ANSWER_PROVIDED',
        entity: 'LoanApplication',
        entityId: application.id,
        details: { documentKey, length: value.length },
      });
      return { ok: true, documentKey };
    }

    if (!isFile) throw new ApiError(400, `Upload ${requested.name} as a file.`, 'file');
    const file = form!.get('file');
    if (!(file instanceof File)) throw new ApiError(400, 'Choose a file to upload.', 'file');

    let stored;
    try {
      stored = await storeDocument(new Uint8Array(await file.arrayBuffer()), requested.type);
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
