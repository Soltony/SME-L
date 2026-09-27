import { describe, expect, it } from 'vitest';
import { brandStyle, brandTokens, contrastRatio, PLATFORM_BRAND } from './brand';

const stops = (style: object) => {
  const s = style as Record<string, string>;
  return [s['--brand-from'], s['--brand'], s['--brand-to']];
};

describe('brand surfaces', () => {
  it('picks dark text on the gold by default', () => {
    expect(brandTokens(PLATFORM_BRAND).isLight).toBe(true);
  });

  it('keeps white text readable on the gold by deepening it', () => {
    const style = brandStyle(PLATFORM_BRAND, { lightText: true }) as Record<string, string>;
    expect(style['--brand-fg']).toBe('#FFFFFF');
    for (const stop of stops(style)) expect(contrastRatio(stop, '#FFFFFF')).toBeGreaterThanOrEqual(3);
  });

  it('leaves a dark lender colour exactly as it was', () => {
    expect(brandStyle('#0E7C66', { lightText: true })).toEqual(brandStyle('#0E7C66'));
  });
});
