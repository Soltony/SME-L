import type { CSSProperties } from 'react';

/**
 * A provider's brand colour, turned into something safe to paint a card with.
 *
 * Providers choose their own `colorHex`, so every surface tinted with it has to
 * work for a dark navy and for a bright yellow alike. Nothing here picks a
 * colour — it only derives the pieces a brand surface needs: a readable
 * foreground, a slightly deeper shade for a gradient, and translucent tints for
 * borders and chips. The result is handed to the DOM as custom properties, so a
 * component styles itself with `var(--brand)` instead of interpolating hex into
 * a dozen inline styles.
 */

const FALLBACK = '#E0A70B';
/** Near-black rather than pure black: it sits better on a saturated colour. */
const DARK_INK = '#12161F';
const LIGHT_INK = '#FFFFFF';

/** `#abc`, `abcdef` and `#ABCDEF` all become `#aabbcc`-style six-digit hex. */
export function normalizeHex(value: string | null | undefined): string {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return FALLBACK;
}

function toRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white text over `hex`, whichever a reader can actually make out.
 *
 * The reference app painted white on every provider colour, which is why a
 * yellow card's figures were barely legible. Choosing by contrast means a
 * provider can pick any colour and the amounts stay readable.
 */
export function readableOn(hex: string): string {
  return contrastRatio(hex, DARK_INK) >= contrastRatio(hex, LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

/** `hex` moved towards black (negative) or white (positive) by `amount` of the way. */
export function shade(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(amount));
  const channels = toRgb(hex).map((c) => Math.round(c + (target - c) * t));
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Hex with an alpha suffix, for hairlines and chips over a neutral surface. */
export function alpha(hex: string, opacity: number): string {
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${normalizeHex(hex)}${a}`;
}

export interface BrandTokens {
  hex: string;
  foreground: string;
  /** True when the card's text is dark — panels over it need a different tint. */
  isLight: boolean;
}

export function brandTokens(hex: string | null | undefined): BrandTokens {
  const base = normalizeHex(hex);
  const foreground = readableOn(base);
  return { hex: base, foreground, isLight: foreground === DARK_INK };
}

/**
 * The custom properties a brand surface reads: the colour itself, a readable
 * foreground, the two stops of its gradient, and a translucent version of the
 * foreground for separators and chips.
 */
export function brandStyle(hex: string | null | undefined): CSSProperties {
  const { hex: base, foreground, isLight } = brandTokens(hex);
  return {
    '--brand': base,
    '--brand-fg': foreground,
    // A light brand lifts towards white, a dark one deepens: either way the
    // gradient reads as the same colour lit from the top left.
    '--brand-from': isLight ? shade(base, 0.12) : shade(base, 0.16),
    '--brand-to': shade(base, -0.18),
    '--brand-line': isLight ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.22)',
    '--brand-chip': isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.18)',
    '--brand-soft': alpha(base, 0.12),
    '--brand-edge': alpha(base, 0.35),
  } as CSSProperties;
}

/**
 * The honeycomb watermark from the reference app's account card, as a CSS
 * background rather than an inline `<svg>`.
 *
 * The original inlined a `<pattern id="hex-pattern">` per card; ids are
 * document-global, so a second card on the page silently reused the first
 * one's. A background image has no ids to collide and no extra DOM.
 */
export function honeycomb(stroke: string, opacity = 0.5): CSSProperties {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="69.28" viewBox="0 0 40 69.28">` +
    `<polygon points="20,0 40,17.32 40,51.96 20,69.28 0,51.96 0,17.32" fill="none" ` +
    `stroke="${stroke}" stroke-width="1.5" stroke-opacity="${opacity}"/></svg>`;
  return { backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, backgroundRepeat: 'repeat' };
}
