/**
 * Images stored inline, as a base64 `data:` URI.
 *
 * The alternative — writing uploads to disk and serving them back by URL —
 * needs a file store to back up, a persistent volume that survives a release,
 * and a route to serve from. Inlining keeps the image in the row that owns it
 * and costs one thing instead: a size cap, which is what the callers here set.
 *
 * Base64 specifically, never a raw `data:image/svg+xml,<svg …>`: a plain-text
 * SVG carries markup, and `findMarkupField` refuses markup in any submitted
 * field before it is ever stored. An inline image is only ever rendered through
 * an `<img>` element, which does not run script inside an SVG.
 */

/** Image types an upload may use. SVG is allowed; it is never inlined as markup. */
export const INLINE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;

const INLINE_IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** True when the value is an inline image rather than some other stored form. */
export function isInlineImage(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('data:');
}

/** A byte cap expressed for the stored string: base64 costs a third more, plus the prefix. */
export function inlineImageUriLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3) + 64;
}

/** Whether a stored value is an inline image we would accept back. */
export function isValidInlineImage(value: string, maxUriLength: number): boolean {
  return value.length <= maxUriLength && INLINE_IMAGE.test(value);
}

/** The message shown when an upload is the wrong type or too large. */
export function inlineImageError(maxBytes: number): string {
  return `Upload a PNG, JPG, WEBP or SVG under ${Math.round(maxBytes / 1024)} KB.`;
}
