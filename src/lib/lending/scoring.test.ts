import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  loanCycleSchema,
  normalizeFieldName,
  scoreBorrower,
  scoringModelSchema,
  tiersSchema,
} from './scoring';
import { boolish, productPricingSchema } from './terms';

describe('field names', () => {
  it('match regardless of case, spaces and punctuation', () => {
    expect(normalizeFieldName('Monthly_Income')).toBe(normalizeFieldName('monthly income'));
    expect(normalizeFieldName('Years-in business')).toBe('yearsinbusiness');
  });
});

describe('evaluateRule', () => {
  it('compares numbers numerically, including numeric strings with separators', () => {
    expect(evaluateRule('120,000', '>=', '100000')).toBe(true);
    expect(evaluateRule(99, '>', '100')).toBe(false);
    expect(evaluateRule('9', '<', '10')).toBe(true); // not a string comparison
  });

  it('supports between and in', () => {
    expect(evaluateRule(50, 'between', '10,50')).toBe(true);
    expect(evaluateRule(51, 'between', '10..50')).toBe(false);
    expect(evaluateRule('Retail', 'in', 'food, retail')).toBe(true);
    expect(evaluateRule('Mining', 'in', 'food, retail')).toBe(false);
  });

  it('never matches a missing value', () => {
    expect(evaluateRule(undefined, '!=', 'x')).toBe(false);
    expect(evaluateRule('', '==', '')).toBe(false);
  });
});

describe('scoreBorrower', () => {
  const model = scoringModelSchema.parse([
    {
      name: 'Revenue',
      weight: 40,
      rules: [
        { field: 'Monthly revenue', operator: '>=', value: '100000', score: 40 },
        { field: 'Monthly revenue', operator: '>=', value: '20000', score: 15 },
      ],
    },
    { name: 'History', weight: 30, rules: [{ field: 'onTimeLoans', operator: '>=', value: '1', score: 30 }] },
  ]);

  it('takes the best matching rule per parameter, capped at its weight', () => {
    const result = scoreBorrower(model, { monthly_revenue: 150000, OnTimeLoans: 0 });
    expect(result.total).toBe(40);
    expect(result.maxPossible).toBe(70);
    expect(result.breakdown[1]).toMatchObject({ parameter: 'History', points: 0, matchedRule: null });
  });
});

describe('model validation', () => {
  it('refuses rules worth more than their parameter and malformed ranges', () => {
    const parsed = scoringModelSchema.safeParse([
      { name: 'A', weight: 10, rules: [{ field: 'x', operator: 'between', value: '9,1', score: 20 }] },
    ]);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message).join(' ');
    expect(messages).toMatch(/min,max/);
    expect(messages).toMatch(/exceed/);
  });

  it('refuses overlapping amount tiers', () => {
    expect(tiersSchema.safeParse([{ minScore: 0, maxScore: 50, maxAmount: '1000' }, { minScore: 50, maxScore: 100, maxAmount: '5000' }]).success).toBe(false);
    expect(tiersSchema.safeParse([{ minScore: 0, maxScore: 49, maxAmount: '1000' }, { minScore: 50, maxScore: 100, maxAmount: '5000' }]).success).toBe(true);
  });

});

describe('boolish', () => {
  it('reads "false" as false — z.coerce.boolean() would not', () => {
    expect(boolish.parse('false')).toBe(false);
    expect(boolish.parse('true')).toBe(true);
    expect(boolish.parse(false)).toBe(false);
    expect(boolish.safeParse('maybe').success).toBe(false);
  });
});

describe('product pricing validation', () => {
  const base = {
    minAmount: '1000',
    maxAmount: '5000',
    durationDays: 30,
    installmentCount: 1,
    serviceFeeType: 'PERCENT',
    serviceFeeValue: '2',
    interestType: 'PERCENT_DAILY',
    interestValue: '0.1',
    interestBasis: 'SIMPLE',
    accrueInterestAfterMaturity: false,
    penaltyRules: [],
  };

  it('accepts a sensible product', () => {
    expect(productPricingSchema.safeParse(base).success).toBe(true);
  });

  it('refuses impossible or absurd configurations', () => {
    expect(productPricingSchema.safeParse({ ...base, maxAmount: '500' }).success).toBe(false);
    expect(productPricingSchema.safeParse({ ...base, installmentCount: 31 }).success).toBe(false);
    expect(productPricingSchema.safeParse({ ...base, interestValue: '150' }).success).toBe(false);
    expect(productPricingSchema.safeParse({ ...base, serviceFeeValue: '0' }).success).toBe(false);
    expect(
      productPricingSchema.safeParse({
        ...base,
        penaltyRules: [
          { fromDay: 1, toDay: 10, type: 'FIXED', value: '5', frequency: 'DAILY' },
          { fromDay: 5, toDay: null, type: 'FIXED', value: '9', frequency: 'DAILY' },
        ],
      }).success
    ).toBe(false);
  });
});
