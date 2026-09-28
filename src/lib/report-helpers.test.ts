import { describe, expect, it } from 'vitest';
import { dayToIso, isoToDay } from './business-date';
import {
  classifyNbe,
  describeInterest,
  describeServiceFee,
  isNbeClass,
  repaymentFrequency,
  reportPeriods,
  splitFullName,
  trendGranularity,
  trendKey,
  trendKeys,
} from './report-helpers';

describe('classifyNbe', () => {
  it('classifies at the edges of every band', () => {
    expect(classifyNbe(0)).toBe('PASS');
    expect(classifyNbe(29)).toBe('PASS');
    expect(classifyNbe(30)).toBe('SPECIAL_MENTION');
    expect(classifyNbe(89)).toBe('SPECIAL_MENTION');
    expect(classifyNbe(90)).toBe('SUBSTANDARD');
    expect(classifyNbe(179)).toBe('SUBSTANDARD');
    expect(classifyNbe(180)).toBe('DOUBTFUL');
    expect(classifyNbe(359)).toBe('DOUBTFUL');
    expect(classifyNbe(360)).toBe('LOSS');
    expect(classifyNbe(5000)).toBe('LOSS');
  });

  it('treats a negative count as current', () => {
    expect(classifyNbe(-3)).toBe('PASS');
  });

  it('recognises only real class keys from a query string', () => {
    expect(isNbeClass('DOUBTFUL')).toBe(true);
    expect(isNbeClass('doubtful')).toBe(false);
    expect(isNbeClass(undefined)).toBe(false);
  });
});

describe('reportPeriods', () => {
  const periods = (iso: string) =>
    Object.fromEntries(reportPeriods(isoToDay(iso)).map((p) => [p.key, `${dayToIso(p.from)}..${dayToIso(p.to)}`]));

  it('runs every period to today', () => {
    // 2026-09-28 is a Monday.
    const p = periods('2026-09-28');
    expect(p.today).toBe('2026-09-28..2026-09-28');
    expect(p.week).toBe('2026-09-28..2026-09-28');
    expect(p.month).toBe('2026-09-01..2026-09-28');
    expect(p.quarter).toBe('2026-07-01..2026-09-28');
    expect(p.half).toBe('2026-07-01..2026-09-28');
    expect(p.year).toBe('2026-01-01..2026-09-28');
  });

  it('starts the week on Monday', () => {
    expect(periods('2026-09-27').week).toBe('2026-09-21..2026-09-27'); // Sunday
    expect(periods('2026-09-30').week).toBe('2026-09-28..2026-09-30'); // Wednesday
  });

  it('covers the whole of last month, across a year end', () => {
    expect(periods('2026-03-15').lastMonth).toBe('2026-02-01..2026-02-28');
    expect(periods('2026-01-10').lastMonth).toBe('2025-12-01..2025-12-31');
    expect(periods('2026-02-10').quarter).toBe('2026-01-01..2026-02-10');
  });
});

describe('trend buckets', () => {
  it('switches to monthly points past two months', () => {
    const from = isoToDay('2026-01-01');
    expect(trendGranularity(from, from + 62)).toBe('day');
    expect(trendGranularity(from, from + 63)).toBe('month');
  });

  it('lists every day, including empty ones', () => {
    expect(trendKeys(isoToDay('2026-02-27'), isoToDay('2026-03-02'), 'day')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('lists every month the range touches', () => {
    expect(trendKeys(isoToDay('2025-11-15'), isoToDay('2026-02-03'), 'month')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(trendKey(isoToDay('2026-02-03'), 'month')).toBe('2026-02');
  });
});

describe('splitFullName', () => {
  it('reads given, father and grandfather names', () => {
    expect(splitFullName('Abebe Kebede Tesfaye')).toEqual(['Abebe', 'Kebede', 'Tesfaye']);
    expect(splitFullName('  Abebe   Kebede ')).toEqual(['Abebe', '', 'Kebede']);
    expect(splitFullName('Abebe Kebede Tesfaye Alemu')).toEqual(['Abebe', 'Kebede', 'Tesfaye Alemu']);
    expect(splitFullName(null)).toEqual(['', '', '']);
  });
});

describe('repaymentFrequency', () => {
  it('names the interval between installments', () => {
    expect(repaymentFrequency(30, 1)).toBe('Single payment');
    expect(repaymentFrequency(28, 4)).toBe('Weekly');
    expect(repaymentFrequency(90, 3)).toBe('Monthly');
    expect(repaymentFrequency(360, 4)).toBe('Quarterly');
    expect(repaymentFrequency(360, 2)).toBe('Every 180 days');
  });
});

describe('pricing descriptions', () => {
  it('states interest and fees as the loan terms do', () => {
    expect(describeInterest({ currency: 'ETB', interest: { type: 'PERCENT_DAILY', value: '0.1', basis: 'SIMPLE', afterMaturity: false } })).toBe('0.1% per day');
    expect(describeInterest({ currency: 'ETB', interest: { type: 'PERCENT_DAILY', value: '0.1', basis: 'COMPOUND', afterMaturity: false } })).toBe('0.1% per day, compound');
    expect(describeInterest({ currency: 'ETB', interest: { type: 'FIXED_DAILY', value: '5', basis: 'SIMPLE', afterMaturity: false } })).toBe('ETB 5 per day');
    expect(describeInterest({ currency: 'ETB', interest: { type: 'NONE', value: '0', basis: 'SIMPLE', afterMaturity: false } })).toBe('None');
    expect(describeServiceFee({ currency: 'ETB', serviceFee: { type: 'PERCENT', value: '2' } })).toBe('2%');
    expect(describeServiceFee({ currency: 'ETB', serviceFee: { type: 'FIXED', value: '50' } })).toBe('ETB 50');
  });
});
