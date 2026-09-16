import { describe, expect, it } from 'vitest';
import { findMarkupField } from './plain-text';
import { providerSchema } from './lending/catalog';
import { isValidProviderIcon, MAX_PROVIDER_ICON_BYTES } from './provider-icon';

const png = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

describe('isValidProviderIcon', () => {
  it('accepts the curated names and small base64 uploads', () => {
    expect(isValidProviderIcon('Landmark')).toBe(true);
    expect(isValidProviderIcon('PiggyBank')).toBe(true);
    expect(isValidProviderIcon(png(2048))).toBe(true);
    expect(isValidProviderIcon(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBe(true);
  });

  it('refuses names outside the list', () => {
    expect(isValidProviderIcon('Skull')).toBe(false);
    expect(isValidProviderIcon('')).toBe(false);
  });

  it('refuses an upload over the size cap', () => {
    expect(isValidProviderIcon(png(MAX_PROVIDER_ICON_BYTES))).toBe(true);
    expect(isValidProviderIcon(png(MAX_PROVIDER_ICON_BYTES + 1024))).toBe(false);
  });

  it('refuses anything that is not a base64 image', () => {
    // Plain-text SVG carries markup; only the base64 form is stored.
    expect(isValidProviderIcon('data:image/svg+xml,<svg onload="alert(1)"/>')).toBe(false);
    expect(isValidProviderIcon('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isValidProviderIcon('https://example.com/logo.png')).toBe(false);
    expect(isValidProviderIcon('javascript:alert(1)')).toBe(false);
  });

  it('never trips the markup guard for an accepted upload', () => {
    expect(findMarkupField({ icon: png(4096) })).toBeNull();
  });
});

describe('providerSchema', () => {
  const base = { code: 'PRO0001', name: 'Addis SME Finance' };

  it('defaults the icon and stores blank account numbers as null', () => {
    const parsed = providerSchema.parse({ ...base, fundingAccountNo: '', collectionAccountNo: '' });
    expect(parsed.icon).toBe('Landmark');
    expect(parsed.collectionAccountNo).toBeNull();
  });

  it('keeps a collection account and checks its characters', () => {
    expect(providerSchema.parse({ ...base, collectionAccountNo: '1000900101' }).collectionAccountNo).toBe('1000900101');
    expect(providerSchema.safeParse({ ...base, collectionAccountNo: '1000 9001' }).success).toBe(false);
  });

  it('rejects an icon it would not render', () => {
    expect(providerSchema.safeParse({ ...base, icon: 'Skull' }).success).toBe(false);
  });
});
