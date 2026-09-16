import { describe, expect, it } from 'vitest';
import { cycleRangeLabel, loanCyclePosition, loanCycleSchema, loanCycleUnreadable, parseLoanCycle, type CycleHistory } from './scoring';
import { productSchema } from './catalog';

const table = {
  enabled: true,
  metric: 'ON_TIME_LOANS',
  lateSetsBack: false,
  cycles: [0, 1, 3],
  grades: [
    { label: 'A', minScore: 70, percents: [50, 75, 100] },
    { label: 'B', minScore: 40, percents: [30, 60, 90] },
    { label: 'C', minScore: 0, percents: [0, 40, 70] },
  ],
};
const config = loanCycleSchema.parse(table);
const history = (h: Partial<CycleHistory> = {}): CycleHistory => ({ paidOffLoans: 0, onTimeLoans: 0, earlyLoans: 0, lateLoans: 0, ...h });

describe('loanCyclePosition', () => {
  it('reads the cell for the borrower grade and cycle', () => {
    expect(loanCyclePosition(config, history(), 85).percent).toBe(50);
    expect(loanCyclePosition(config, history({ onTimeLoans: 2 }), 50).percent).toBe(60);
    expect(loanCyclePosition(config, history({ onTimeLoans: 9 }), 10).percent).toBe(70);
  });

  it('places a score exactly on a boundary in the higher grade', () => {
    expect(loanCyclePosition(config, history(), 70).grade).toBe('A');
    expect(loanCyclePosition(config, history(), 69).grade).toBe('B');
  });

  it('gives the lowest grade, not the whole tier, to the lowest scores', () => {
    // The reference implementation fell back to 100% for a score below every grade.
    const position = loanCyclePosition(config, history(), 0);
    expect(position.grade).toBe('C');
    expect(position.percent).toBe(0);
  });

  it('uses the grade that starts at 0 when the product is not scored', () => {
    expect(loanCyclePosition(config, history({ onTimeLoans: 1 }), null)).toMatchObject({ grade: 'C', percent: 40 });
  });

  it('counts what the metric says', () => {
    const h = history({ paidOffLoans: 4, onTimeLoans: 1, earlyLoans: 0 });
    expect(loanCyclePosition({ ...config, metric: 'PAID_OFF_LOANS' }, h, 85).cycle).toBe(2);
    expect(loanCyclePosition({ ...config, metric: 'ON_TIME_LOANS' }, h, 85).cycle).toBe(1);
    expect(loanCyclePosition({ ...config, metric: 'EARLY_LOANS' }, h, 85).cycle).toBe(0);
  });

  it('moves a borrower back a cycle for each late loan when asked to, never below the first', () => {
    const h = history({ paidOffLoans: 4, lateLoans: 2 });
    const paidOff = { ...config, metric: 'PAID_OFF_LOANS' as const };
    expect(loanCyclePosition(paidOff, h, 85)).toMatchObject({ count: 4, cycle: 2 });
    expect(loanCyclePosition({ ...paidOff, lateSetsBack: true }, h, 85)).toMatchObject({ count: 2, cycle: 1 });
    expect(loanCyclePosition({ ...paidOff, lateSetsBack: true }, history({ paidOffLoans: 1, lateLoans: 5 }), 85).count).toBe(0);
  });

  it('describes the position for the reviewer', () => {
    expect(loanCyclePosition(config, history({ onTimeLoans: 2 }), 85).description).toBe('cycle 2 (1–2 loans repaid on time or early), grade A');
  });
});

describe('cycleRangeLabel', () => {
  it('names each cycle by the loan counts it covers', () => {
    expect([0, 1, 2].map((i) => cycleRangeLabel([0, 1, 3], i))).toEqual(['0', '1–2', '3+']);
  });
});

describe('loanCycleSchema', () => {
  const issues = (input: unknown) => {
    const parsed = loanCycleSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };

  it('requires the first cycle and one grade to start at 0, so nobody falls outside the table', () => {
    expect(issues({ ...table, cycles: [1, 3], grades: [{ label: 'A', minScore: 0, percents: [50, 100] }] })).toContain(
      'The first cycle is for new borrowers and starts at 0 loans.'
    );
    expect(issues({ ...table, grades: [{ label: 'A', minScore: 50, percents: [50, 75, 100] }] })).toContain(
      'One grade must start at score 0, so every borrower has a grade.'
    );
  });

  it('refuses cycles out of order, repeated grade scores and short rows', () => {
    expect(issues({ ...table, cycles: [0, 3, 3] })).toContain('Each cycle must start at more loans than the one before.');
    expect(issues({ ...table, grades: [...table.grades, { label: 'D', minScore: 0, percents: [0, 0, 0] }] })).toContain('Two grades start at the same score.');
    expect(issues({ ...table, grades: [{ label: 'A', minScore: 0, percents: [50, 100] }] })).toContain('Grade A needs a percentage for every cycle.');
  });

  it('refuses a later cycle giving less than an earlier one when saving', () => {
    const decreasing = { ...table, grades: [{ label: 'A', minScore: 0, percents: [80, 8, 100] }] };
    expect(issues(decreasing).join(' ')).toMatch(/cannot give less/);
    // …but a table already stored that way still applies as approved.
    expect(parseLoanCycle(JSON.stringify(decreasing))?.grades[0].percents).toEqual([80, 8, 100]);
  });

  it('reads the single-row tables saved before grades existed', () => {
    const legacy = JSON.stringify({ enabled: true, metric: 'PAID_OFF_LOANS', steps: [{ minCount: 2, percent: 100 }, { minCount: 0, percent: 50 }] });
    const parsed = parseLoanCycle(legacy)!;
    expect(parsed.cycles).toEqual([0, 2]);
    expect(parsed.grades).toEqual([{ label: 'All scores', minScore: 0, percents: [50, 100] }]);
    expect(parsed.lateSetsBack).toBe(false);
  });
});

describe('loanCycleUnreadable', () => {
  it('flags a switched-on table that cannot be read, so the product refuses instead of lending without it', () => {
    expect(loanCycleUnreadable(null)).toBe(false);
    expect(loanCycleUnreadable(JSON.stringify(table))).toBe(false);
    expect(loanCycleUnreadable(JSON.stringify({ ...table, enabled: false }))).toBe(false);
    expect(loanCycleUnreadable(JSON.stringify({ ...table, cycles: [] }))).toBe(true);
    expect(loanCycleUnreadable('{not json')).toBe(true);
  });
});

describe('productSchema and loan cycles', () => {
  const product = {
    providerId: 'p1',
    code: 'WC30',
    name: 'Working capital',
    minAmount: '1000',
    maxAmount: '5000',
    durationDays: 30,
    installmentCount: 1,
    serviceFeeType: 'NONE',
    serviceFeeValue: '0',
    interestType: 'NONE',
    interestValue: '0',
    interestBasis: 'SIMPLE',
    accrueInterestAfterMaturity: false,
    penaltyRules: [],
  };

  it('refuses several grades on a product that does not score borrowers', () => {
    const parsed = productSchema.safeParse({ ...product, requiresScoring: false, cycleConfig: table });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ')).toMatch(/Grades need credit scoring/);
    expect(productSchema.safeParse({ ...product, requiresScoring: true, cycleConfig: table }).success).toBe(true);
  });
});
