import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { ApiError, handle, isGuardFailure, jsonError, requirePermission } from '@/lib/api';
import { createAuditLog } from '@/lib/audit-log';
import { MAX_UPLOAD_BYTES, parseColumns, parseUpload, UploadError } from '@/lib/data-provisioning';
import { cleanFileName } from '@/lib/documents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Uploads borrower data for scoring. Rows replace the borrower's previous row
 * in this data set; rejected rows are listed back with the reason.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requirePermission('credit-scoring', 'create');
  if (isGuardFailure(guard)) return guard.response;
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64_000) {
    return jsonError('The file is larger than 10 MB.', 413);
  }
  const { configId } = await params;

  return handle(async () => {
    const config = await prisma.dataProvisioningConfig.findUnique({ where: { id: configId } });
    if (!config || (guard.user.providerId && config.providerId !== guard.user.providerId)) {
      throw new ApiError(404, 'Data set not found.');
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw new ApiError(400, 'Choose a file to upload.', 'file');

    let parsed;
    try {
      parsed = parseUpload(new Uint8Array(await file.arrayBuffer()), file.name, parseColumns(config.columns));
    } catch (error) {
      if (error instanceof UploadError) throw new ApiError(400, error.message, 'file');
      throw error;
    }

    const upload = await prisma.dataUpload.create({
      data: {
        configId,
        fileName: cleanFileName(file.name),
        totalRows: parsed.totalRows,
        acceptedRows: parsed.accepted.length,
        rejectedRows: parsed.rejections.length,
        rejections: parsed.rejections.length ? JSON.stringify(parsed.rejections.slice(0, 500)) : null,
        uploadedById: guard.user.id,
        uploadedBy: guard.user.fullName,
      },
    });

    // Chunked so a large file does not become one enormous transaction.
    for (let i = 0; i < parsed.accepted.length; i += 250) {
      const chunk = parsed.accepted.slice(i, i + 250);
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.borrowerDataRow.upsert({
            where: { configId_borrowerKey: { configId, borrowerKey: row.borrowerKey } },
            create: { configId, uploadId: upload.id, borrowerKey: row.borrowerKey, data: JSON.stringify(row.data) },
            update: { uploadId: upload.id, data: JSON.stringify(row.data) },
          })
        )
      );
    }

    await createAuditLog({
      actorId: guard.user.id,
      actorName: guard.user.fullName,
      action: 'DATA_UPLOADED',
      entity: 'DataProvisioningConfig',
      entityId: configId,
      details: {
        uploadId: upload.id,
        fileName: upload.fileName,
        totalRows: parsed.totalRows,
        accepted: parsed.accepted.length,
        rejected: parsed.rejections.length,
      },
    });

    return {
      ok: true,
      message: `${parsed.accepted.length} of ${parsed.totalRows} rows loaded.`,
      accepted: parsed.accepted.length,
      rejected: parsed.rejections.length,
      rejections: parsed.rejections.slice(0, 100),
    };
  });
}
