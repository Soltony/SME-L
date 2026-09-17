import { INLINE_IMAGE_MIME_TYPES, inlineImageError, inlineImageUriLength, isValidInlineImage } from './inline-image';

/**
 * The operator's own brand mark, stored inline on the `platform.logo` setting
 * the same way a provider stores its icon. Empty means the built-in `LogoMark`.
 *
 * This lives apart from `settings.ts` on purpose: the uploader is a client
 * component and needs the limits below, while `settings.ts` reaches for Prisma.
 */

export const PLATFORM_LOGO_MIME_TYPES = INLINE_IMAGE_MIME_TYPES;

/**
 * Larger than a provider icon — this one is shown at the top of every screen
 * and may be a wordmark rather than a square — but still far inside the 256 KB
 * cap on a JSON body, which it shares with the rest of the settings form.
 */
export const MAX_PLATFORM_LOGO_BYTES = 96 * 1024;

export const MAX_PLATFORM_LOGO_URI_LENGTH = inlineImageUriLength(MAX_PLATFORM_LOGO_BYTES);

export const PLATFORM_LOGO_ERROR = inlineImageError(MAX_PLATFORM_LOGO_BYTES);

/** Empty clears the logo; anything else has to be an inline image we would serve. */
export function isValidPlatformLogo(value: string): boolean {
  return value === '' || isValidInlineImage(value, MAX_PLATFORM_LOGO_URI_LENGTH);
}
