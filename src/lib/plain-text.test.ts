import { describe, expect, it } from 'vitest';
import { containsMarkup, findMarkupField } from './plain-text';

describe('containsMarkup', () => {
  it('catches what a parser would read as a tag', () => {
    expect(containsMarkup('<script>alert(1)</script>')).toBe(true);
    expect(containsMarkup('<img src=x onerror=alert(1)>')).toBe(true);
    expect(containsMarkup('Abebe <b>Bekele</b>')).toBe(true);
    expect(containsMarkup('</div>')).toBe(true);
    expect(containsMarkup('<!-- comment -->')).toBe(true);
  });

  it('leaves prose that merely compares things alone', () => {
    // A rule that rejected these would be worked around, not obeyed.
    expect(containsMarkup('under 18 < 21')).toBe(false);
    expect(containsMarkup('5<10 bids')).toBe(false);
    expect(containsMarkup('Abebe Bekele')).toBe(false);
    expect(containsMarkup('ሰላም ዓለም')).toBe(false);
    expect(containsMarkup('')).toBe(false);
  });
});

describe('findMarkupField', () => {
  it('names the field so the refusal can be shown under it', () => {
    expect(findMarkupField({ fullName: '<script>alert(1)</script>', email: 'a@b.co' })).toBe(
      'fullName'
    );
  });

  it('passes a clean body', () => {
    expect(
      findMarkupField({ fullName: 'Abebe Bekele', email: 'a@b.co', phoneNumber: '0912345678' })
    ).toBeNull();
  });

  it('reaches nested objects and arrays', () => {
    expect(findMarkupField({ values: { 'platform.name': '<b>x</b>' } })).toBe(
      'values.platform.name'
    );
    expect(findMarkupField({ entries: ['fine', '<script>x</script>'] })).toBe('entries[1]');
  });

  it('ignores values that are not text', () => {
    expect(findMarkupField({ amount: 250, active: true, note: null })).toBeNull();
  });

  it('does not recurse without end', () => {
    const deep: any = {};
    let node = deep;
    for (let i = 0; i < 50; i += 1) {
      node.next = {};
      node = node.next;
    }
    node.value = '<script>x</script>';
    expect(() => findMarkupField(deep)).not.toThrow();
  });
});
