import { describe, expect, it } from 'vitest';
import { buildFieldCatalogue, findField, modelFieldIssues, oneFieldPerParameter } from './scoring-fields';
import { scoringModelSchema } from './scoring';

const dataSets = [
  {
    name: 'Business profile',
    columns: [
      { name: 'Phone', type: 'string', isIdentifier: true },
      { name: 'Sector', type: 'string', isIdentifier: false },
      { name: 'Monthly revenue', type: 'number', isIdentifier: false },
      { name: 'Registered on', type: 'date', isIdentifier: false },
      // Clashes with a built-in history field once names are normalised.
      { name: 'on_time_loans', type: 'number', isIdentifier: false },
    ],
  },
];

describe('buildFieldCatalogue', () => {
  const catalogue = buildFieldCatalogue(dataSets, { sector: ['Food', 'Retail'], occupation: ['Trader'] });

  it('offers core banking, loan history and uploaded columns, grouped', () => {
    expect(findField(catalogue, 'avgMonthlyDeposit')?.group).toMatch(/Core banking/);
    expect(findField(catalogue, 'paidOffLoans')?.group).toBe('Loan history on this platform');
    expect(findField(catalogue, 'Monthly revenue')).toMatchObject({ type: 'number', group: 'Uploaded data — Business profile' });
  });

  it('leaves out the phone identifier and date columns, which no rule can compare', () => {
    expect(findField(catalogue, 'Phone')).toBeUndefined();
    expect(findField(catalogue, 'Registered on')).toBeUndefined();
  });

  it('keeps the built-in field when an upload uses the same name', () => {
    expect(catalogue.filter((f) => findField([f], 'onTimeLoans'))).toHaveLength(1);
    expect(findField(catalogue, 'on_time_loans')?.source).toBe('HISTORY');
  });

  it('attaches known values to text fields only', () => {
    expect(findField(catalogue, 'Sector')?.options).toEqual(['Food', 'Retail']);
    expect(findField(catalogue, 'occupation')?.options).toEqual(['Trader']);
    expect(findField(catalogue, 'Monthly revenue')?.options).toBeUndefined();
  });

  it('does not offer identifying or protected customer details', () => {
    for (const key of ['nationalId', 'motherName', 'gender', 'maritalStatus', 'customerName', 'dateOfBirth']) {
      expect(findField(catalogue, key)).toBeUndefined();
    }
  });
});

describe('modelFieldIssues', () => {
  const catalogue = buildFieldCatalogue(dataSets);
  const model = (field: string, operator: string) =>
    scoringModelSchema.parse([{ field, weight: 10, rules: [{ operator, value: operator === 'in' ? 'a,b' : '5', score: 5 }] }]);

  it('accepts a field from the list with an operator that suits it', () => {
    expect(modelFieldIssues(model('avgBalance', '>='), catalogue)).toEqual([]);
    expect(modelFieldIssues(model('sector', 'in'), catalogue)).toEqual([]);
  });

  it('refuses a field that is not in the list', () => {
    expect(modelFieldIssues(model('Monthly revnue', '>='), catalogue)[0]).toMatchObject({ path: [0, 'field'] });
  });

  it('refuses comparisons that do not suit the field type', () => {
    expect(modelFieldIssues(model('Sector', '>='), catalogue)[0].message).toMatch(/text/);
    expect(modelFieldIssues(model('avgBalance', 'in'), catalogue)[0].message).toMatch(/number/);
  });
});

describe('scoringModelSchema', () => {
  it('gives every rule its parameter field and refuses the same field twice', () => {
    const [parameter] = scoringModelSchema.parse([{ field: 'avgBalance', weight: 10, rules: [{ operator: '>=', value: '1', score: 5 }] }]);
    expect(parameter.rules[0].field).toBe('avgBalance');
    const twice = scoringModelSchema.safeParse([
      { field: 'avgBalance', weight: 10, rules: [{ operator: '>=', value: '1', score: 5 }] },
      { field: 'avg_balance', weight: 10, rules: [{ operator: '>=', value: '9', score: 5 }] },
    ]);
    expect(twice.success).toBe(false);
  });
});

describe('oneFieldPerParameter', () => {
  it('leaves single-field parameters alone', () => {
    const result = oneFieldPerParameter([{ name: 'Revenue', weight: 40, rules: [{ field: 'Monthly revenue', score: 40 }] }]);
    expect(result).toEqual({ split: false, parameters: [{ field: 'Monthly revenue', weight: 40, rules: [{ field: 'Monthly revenue', score: 40 }] }] });
  });

  it('splits a parameter that mixed fields, weighting each part at its best rule', () => {
    const result = oneFieldPerParameter([
      {
        name: 'Repayment history',
        weight: 30,
        rules: [
          { field: 'onTimeLoans', score: 30 },
          { field: 'onTimeLoans', score: 22 },
          { field: 'disbursedLoans', score: 15 },
        ],
      },
    ]);
    expect(result.split).toBe(true);
    expect(result.parameters.map((p) => [p.field, p.weight, p.rules.length])).toEqual([
      ['onTimeLoans', 30, 2],
      ['disbursedLoans', 15, 1],
    ]);
  });
});
