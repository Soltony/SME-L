import { INLINE_IMAGE_MIME_TYPES, inlineImageUriLength, isInlineImage, isValidInlineImage } from './inline-image';

/**
 * What a provider's icon may be.
 *
 * Two forms, both stored in a single column: the name of one of the curated
 * Lucide icons below, or an image the operator uploaded, inlined as a base64
 * `data:` URI — see `inline-image.ts` for why that form and what it costs.
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
export const PROVIDER_ICON_MIME_TYPES = INLINE_IMAGE_MIME_TYPES;

/**
 * The largest file an operator may upload. A logo is a few kilobytes; this
 * leaves room for a generous one while staying far inside the 256 KB cap on a
 * JSON request body, which the encoded icon has to share with the rest of the form.
 */
export const MAX_PROVIDER_ICON_BYTES = 64 * 1024;

/** The same cap expressed for the stored string. */
export const MAX_PROVIDER_ICON_URI_LENGTH = inlineImageUriLength(MAX_PROVIDER_ICON_BYTES);

/** True when the icon is an uploaded image rather than one of the named ones. */
export function isUploadedIcon(icon: string | null | undefined): boolean {
  return isInlineImage(icon);
}

export function isProviderIconName(icon: string): icon is ProviderIconName {
  return (PROVIDER_ICON_NAMES as readonly string[]).includes(icon);
}

export function isValidProviderIcon(icon: string): boolean {
  if (isUploadedIcon(icon)) return isValidInlineImage(icon, MAX_PROVIDER_ICON_URI_LENGTH);
  return isProviderIconName(icon);
}

/** The message shown when an icon is neither a known name nor an acceptable upload. */
export const PROVIDER_ICON_ERROR = `Pick one of the icons, or upload a PNG, JPG, WEBP or SVG under ${Math.round(
  MAX_PROVIDER_ICON_BYTES / 1024
)} KB.`;
