import { describe, expect, it } from 'vitest';
import { findMarkupField } from './plain-text';
import { isValidPlatformLogo, MAX_PLATFORM_LOGO_BYTES } from './platform-logo';
import { validateSettingValue } from './settings';

const png = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

describe('isValidPlatformLogo', () => {
  it('accepts an empty value, which falls back to the built-in mark', () => {
    expect(isValidPlatformLogo('')).toBe(true);
  });

  it('accepts base64 uploads of the types we render', () => {
    expect(isValidPlatformLogo(png(2048))).toBe(true);
    expect(isValidPlatformLogo(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBe(true);
  });

  it('refuses an upload over the size cap', () => {
    expect(isValidPlatformLogo(png(MAX_PLATFORM_LOGO_BYTES))).toBe(true);
    expect(isValidPlatformLogo(png(MAX_PLATFORM_LOGO_BYTES + 1024))).toBe(false);
  });

  it('refuses anything that is not a base64 image', () => {
    // Plain-text SVG carries markup; only the base64 form is stored.
    expect(isValidPlatformLogo('data:image/svg+xml,<svg onload="alert(1)"/>')).toBe(false);
    expect(isValidPlatformLogo('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isValidPlatformLogo('javascript:alert(1)')).toBe(false);
    // A remote URL would be a third-party request on every page; inline only.
    expect(isValidPlatformLogo('https://example.com/logo.png')).toBe(false);
  });

  it('never trips the markup guard for an accepted upload', () => {
    expect(findMarkupField({ values: { 'platform.logo': png(4096) } })).toBeNull();
  });
});

describe('platform.logo through validateSettingValue', () => {
  it('stores an accepted upload despite being far over the text cap', () => {
    const logo = png(8192);
    expect(logo.length).toBeGreaterThan(200);
    expect(validateSettingValue('platform.logo', logo)).toEqual({ ok: true, value: logo });
  });

  it('clears the logo on an empty value', () => {
    expect(validateSettingValue('platform.logo', '')).toEqual({ ok: true, value: '' });
  });

  it('refuses a value it would not render', () => {
    const result = validateSettingValue('platform.logo', 'https://example.com/logo.png');
    expect(result.ok).toBe(false);
  });
});
