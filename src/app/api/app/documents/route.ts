import { NextRequest, NextResponse } from 'next/server';
import { ApiError, handle, isBorrowerFailure, jsonError, readJsonBody, requireBorrower, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { MAX_DOCUMENT_BYTES } from '@/lib/documents';
import { borrowerView, profileChecklist, submitBorrowerDocument } from '@/lib/lending/borrower-documents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The borrower's documents: the bank's, and any a lender asked for. */
export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => ({ documents: (await profileChecklist(ctx.borrower.id)).map(borrowerView) }));
}

/**
 * Provides a document, or a new version of one, for review: a file as
 * multipart form data (`documentTypeId`, `file`, `expiresOn`), or — for a
 * document that is typed rather than uploaded — `{ documentTypeId, value,
 * expiresOn }` as JSON. An approved version stays in use until this one is
 * approved.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('documentUpload', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES + 64_000) {
    return jsonError('The file is larger than 5 MB.', 413);
  }

  const isFile = (req.headers.get('content-type') ?? '').includes('multipart/form-data');
  // Read before `handle`, so a body carrying markup is refused the standard way.
  const json = isFile ? null : await readJsonBody<Record<string, unknown>>(req);
  if (json instanceof NextResponse) return json;

  return handle(async () => {
    const form = isFile ? await req.formData().catch(() => null) : null;
    if (isFile && !form) throw new ApiError(400, 'Upload the file as multipart form data.');
    const field = (name: string) => String((isFile ? form?.get(name) : json?.[name]) ?? '').trim();

    let file: { bytes: Uint8Array; name: string } | null = null;
    if (form) {
      const upload = form.get('file');
      if (!(upload instanceof File)) throw new ApiError(400, 'Choose a file to upload.', 'file');
      file = { bytes: new Uint8Array(await upload.arrayBuffer()), name: upload.name };
    }

    const result = await submitBorrowerDocument(ctx.borrower, {
      documentTypeId: field('documentTypeId'),
      file,
      value: isFile ? null : field('value'),
      expiresOn: field('expiresOn') || null,
    });
    return {
      ok: true,
      ...result,
      message: result.replacesApproved
        ? 'Sent for review. Your approved document stays in use until this one is approved.'
        : 'Sent for review. We will let you know by SMS.',
    };
  });
}
