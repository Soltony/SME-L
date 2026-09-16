import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { secureUuid } from './random';
import { DOCUMENT_KINDS, type DocumentKind } from './document-kinds';

export * from './document-kinds';

/**
 * Borrower documents (IDs, business licences, statements).
 *
 * The previous system stored uploads as base64 text in the database, accepted
 * whatever MIME type the browser declared, and let anyone attach files to any
 * application. Here:
 *
 *  - files live on disk outside the web root, under names we generate, and are
 *    served only through an authenticated route that checks who is asking;
 *  - the type is decided by the file's magic number, never by its name or the
 *    declared Content-Type, and only PDF, PNG and JPEG are accepted;
 *  - a SHA-256 of the content is kept, so a reviewer can show the file they
 *    approved is the file on record.
 */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const DOCUMENT_TYPES: Record<string, { extension: string; label: string }> = {
  'application/pdf': { extension: 'pdf', label: 'PDF' },
  'image/png': { extension: 'png', label: 'PNG image' },
  'image/jpeg': { extension: 'jpg', label: 'JPEG image' },
};

export function documentsDir(): string {
  // Runtime storage, not source: keep it out of the build's file tracing.
  const configured = process.env.DOCUMENTS_DIR?.trim();
  return configured
    ? path.resolve(/*turbopackIgnore: true*/ configured)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), 'storage', 'documents');
}

export function sniffDocumentType(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  return null;
}

export class DocumentError extends Error {}

/** A file name safe to show and to put in a Content-Disposition header. */
export function cleanFileName(name: string): string {
  const base = path.basename(String(name || 'document')).replace(/[^\w.\- ]+/g, '_').trim();
  return (base || 'document').slice(0, 120);
}

export async function storeDocument(bytes: Uint8Array, kind: DocumentKind = 'FILE') {
  if (bytes.byteLength === 0) throw new DocumentError('The file is empty.');
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentError('The file is larger than 5 MB.');

  const mimeType = sniffDocumentType(bytes);
  const allowed: readonly string[] = DOCUMENT_KINDS[kind].mimeTypes;
  if (!mimeType || !allowed.includes(mimeType)) {
    throw new DocumentError(
      kind === 'IMAGE'
        ? 'This document must be a photo: a JPEG or PNG file.'
        : kind === 'PDF'
          ? 'This document must be a PDF file.'
          : 'Only PDF, PNG and JPEG files are accepted.'
    );
  }

  const storageName = `${secureUuid()}.${DOCUMENT_TYPES[mimeType].extension}`;
  const directory = documentsDir();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(/*turbopackIgnore: true*/ directory, storageName), bytes, { flag: 'wx' });

  return {
    storageName,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Resolves a stored name to its path, or null when it is not a name we generated. */
export function resolveDocumentPath(storageName: string): string | null {
  if (!/^[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(storageName)) return null;
  const directory = documentsDir();
  const resolved = path.join(/*turbopackIgnore: true*/ directory, storageName);
  return path.dirname(resolved) === directory ? resolved : null;
}

export async function readDocument(storageName: string): Promise<Buffer | null> {
  const filePath = resolveDocumentPath(storageName);
  if (!filePath) return null;
  try {
    return await readFile(/*turbopackIgnore: true*/ filePath);
  } catch {
    return null;
  }
}

export interface RequiredDocument {
  key: string;
  name: string;
  description?: string;
  type: DocumentKind;
}

export function parseRequiredDocuments(raw: string | null | undefined): RequiredDocument[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d && typeof d.key === 'string' && typeof d.name === 'string')
      .map((d) => ({
        key: d.key,
        name: d.name,
        description: typeof d.description === 'string' ? d.description : undefined,
        // Products saved before types existed asked for "photo or PDF".
        type: typeof d.type === 'string' && d.type in DOCUMENT_KINDS ? (d.type as DocumentKind) : 'FILE',
      }));
  } catch {
    return [];
  }
}
