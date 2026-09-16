/**
 * What a provider's icon may be.
 *
 * Two forms, both stored in a single column: the name of one of the curated
 * Lucide icons below, or an image the operator uploaded, inlined as a base64
 * `data:` URI. Inlining keeps a provider's whole identity in its row — no file
 * store to back up, no second request to serve a logo on a borrower's first
 * screen — at the cost of a size cap, which is the point of the constants here.
 *
 * Base64 specifically, never a raw `data:image/svg+xml,<svg …>`: a plain-text
 * SVG carries markup, and `findMarkupField` refuses markup in any submitted
 * field before it is ever stored. Uploaded icons are only ever rendered through
 * an `<img>` element, which does not run script inside an SVG.
 */

/** The icons an operator can pick without uploading anything. */
export const PROVIDER_ICON_NAMES = [
  'Landmark',
  'Building2',
  'Briefcase',
  'Wallet',
  'CreditCard',
  'PiggyBank',
  'Coins',
  'HandCoins',
] as const;

export type ProviderIconName = (typeof PROVIDER_ICON_NAMES)[number];

export const DEFAULT_PROVIDER_ICON: ProviderIconName = 'Landmark';

/** Image types an upload may use. SVG is allowed; it is never inlined as markup. */
export const PROVIDER_ICON_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;

/**
 * The largest file an operator may upload. A logo is a few kilobytes; this
 * leaves room for a generous one while staying far inside the 256 KB cap on a
 * JSON request body, which the encoded icon has to share with the rest of the form.
 */
export const MAX_PROVIDER_ICON_BYTES = 64 * 1024;

/** The same cap expressed for the stored string: base64 costs a third more, plus the prefix. */
export const MAX_PROVIDER_ICON_URI_LENGTH = Math.ceil((MAX_PROVIDER_ICON_BYTES * 4) / 3) + 64;

const UPLOADED_ICON = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** True when the icon is an uploaded image rather than one of the named ones. */
export function isUploadedIcon(icon: string | null | undefined): boolean {
  return typeof icon === 'string' && icon.startsWith('data:');
}

export function isProviderIconName(icon: string): icon is ProviderIconName {
  return (PROVIDER_ICON_NAMES as readonly string[]).includes(icon);
}

export function isValidProviderIcon(icon: string): boolean {
  if (isUploadedIcon(icon)) return icon.length <= MAX_PROVIDER_ICON_URI_LENGTH && UPLOADED_ICON.test(icon);
  return isProviderIconName(icon);
}

/** The message shown when an icon is neither a known name nor an acceptable upload. */
export const PROVIDER_ICON_ERROR = `Pick one of the icons, or upload a PNG, JPG, WEBP or SVG under ${Math.round(
  MAX_PROVIDER_ICON_BYTES / 1024
)} KB.`;
