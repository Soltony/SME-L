import { describe, expect, it } from 'vitest';
import {
  applyRate,
  centsToDecimal,
  mulDivRound,
  parseUserAmount,
  toCents,
  toRateMicro,
} from './money';

describe('toCents', () => {
  it('parses decimal strings exactly', () => {
    expect(toCents('0.10')).toBe(10);
    expect(toCents('0.285')).toBe(29); // Number('0.285') * 100 would give 28.4999…
    expect(toCents('1.005')).toBe(101); // (1.005).toFixed(2) gives "1.00"
    expect(toCents('123456789.99')).toBe(12345678999);
    expect(toCents('-5.555')).toBe(-556);
  });

  it('accepts numbers and Decimal-like objects', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents({ toString: () => '42.50' })).toBe(4250);
    expect(toCents(null)).toBe(0);
  });

  it('refuses things that are not amounts', () => {
    expect(() => toCents('12,50')).toThrow();
    expect(() => toCents('1e3')).toThrow();
    expect(() => toCents(Number.NaN)).toThrow();
  });
});

describe('centsToDecimal', () => {
  it('round-trips', () => {
    for (const c of [0, 1, 10, 99, 100, 12345, -7, -12345]) {
      expect(toCents(centsToDecimal(c))).toBe(c);
    }
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-120)).toBe('-1.20');
  });
});

describe('mulDivRound', () => {
  it('rounds half away from zero', () => {
    expect(mulDivRound(5, 1, 10)).toBe(1);
    expect(mulDivRound(4, 1, 10)).toBe(0);
    expect(mulDivRound(-5, 1, 10)).toBe(-1);
  });

  it('stays exact where float multiplication would overflow precision', () => {
    // 90 billion ETB at 0.123456% — the product exceeds 2^53.
    expect(mulDivRound(9_000_000_000_000, 123_456, 100_000_000)).toBe(11_111_040_000);
  });
});

describe('rates', () => {
  it('applies percent rates in micro-percent', () => {
    expect(toRateMicro('0.5')).toBe(500_000);
    expect(applyRate(100_000, toRateMicro('0.5'))).toBe(500); // 0.5% of 1,000.00 = 5.00
    expect(applyRate(333, toRateMicro('15'))).toBe(50); // 3.33 × 15% = 0.4995 → 0.50
  });
});

describe('parseUserAmount', () => {
  it('accepts plain positive amounts with at most two decimals', () => {
    expect(parseUserAmount('1500')).toBe(150_000);
    expect(parseUserAmount('1,500.25')).toBe(150_025);
    expect(parseUserAmount(20.5)).toBe(2050);
  });

  it('rejects what a coercion would quietly repair', () => {
    for (const bad of ['', '0', '-5', '1.234', '12abc', '1e5', null, undefined]) {
      expect(parseUserAmount(bad)).toBeNull();
    }
  });
});

describe('CSV cells', () => {
  it('neutralise formulas but keep signed amounts numeric', async () => {
    const { csvCell } = await import('./format');
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('-150.25')).toBe('"-150.25"');
    expect(csvCell(null)).toBe('""');
  });
});
