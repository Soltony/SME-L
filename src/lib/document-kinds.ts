/**
 * What a product can ask for under each required document.
 *
 * Deliberately a short list of kinds rather than free-form file types. Word,
 * Excel and text files are not offered: they cannot be told apart from any
 * other zip or text by their content, Office files can carry macros that run on
 * the reviewer's machine, and none of them can be previewed safely. A borrower
 * asked for one can always save it as PDF. Something that is only a value — a
 * TIN, a licence number — is a typed answer, not a file at all.
 */
export const DOCUMENT_KINDS = {
  FILE: {
    label: 'Photo or PDF',
    mimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
    hint: 'PDF, JPEG or PNG, up to 5 MB.',
  },
  IMAGE: {
    label: 'Photo (JPG or PNG)',
    mimeTypes: ['image/png', 'image/jpeg'],
    hint: 'A photo — JPEG or PNG, up to 5 MB.',
  },
  PDF: {
    label: 'PDF only',
    mimeTypes: ['application/pdf'],
    hint: 'A PDF, up to 5 MB.',
  },
  TEXT: {
    label: 'Typed answer (no file)',
    mimeTypes: [],
    hint: 'Type your answer.',
  },
} as const satisfies Record<string, { label: string; mimeTypes: readonly string[]; hint: string }>;

export type DocumentKind = keyof typeof DOCUMENT_KINDS;
export const DOCUMENT_KIND_KEYS = Object.keys(DOCUMENT_KINDS) as [DocumentKind, ...DocumentKind[]];

export const MAX_ANSWER_LENGTH = 500;

/** The file picker's `accept` for a kind. Advisory only: the upload is checked by content. */
export function acceptAttribute(kind: DocumentKind): string {
  const extensions: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg,.jpeg' };
  return DOCUMENT_KINDS[kind].mimeTypes.flatMap((type) => [extensions[type], type]).join(',');
}

/**
 * Required documents not yet provided. A typed document counts only as an
 * answer and a file document only as a file, so a product whose document
 * changed kind after the borrower responded asks for it again in the new form.
 */
export function missingDocuments<T extends { key: string; type: DocumentKind }>(
  required: T[],
  provided: { files: Iterable<string>; answers: Iterable<string> }
): T[] {
  const files = new Set(provided.files);
  const answers = new Set(provided.answers);
  return required.filter((doc) => !(doc.type === 'TEXT' ? answers.has(doc.key) : files.has(doc.key)));
}
