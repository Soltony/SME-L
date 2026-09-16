import { describe, expect, it } from 'vitest';
import { LedgerError, validateJournalLines } from './ledger';
import { isDebitNormal, SYSTEM_ACCOUNTS } from './chart';

describe('validateJournalLines', () => {
  it('accepts a balanced journal and drops zero lines', () => {
    const { lines, total } = validateJournalLines([
      { account: 'CASH', debit: 10_000 },
      { account: 'PENALTY_RECEIVABLE', credit: 0 },
      { account: 'LOANS_RECEIVABLE', credit: 9_000 },
      { account: 'INTEREST_RECEIVABLE', credit: 1_000 },
    ]);
    expect(total).toBe(10_000);
    expect(lines).toHaveLength(3);
  });

  it('refuses a journal that does not balance', () => {
    // The previous system's accrual: a debit with no credit at all.
    expect(() => validateJournalLines([{ account: 'INTEREST_RECEIVABLE', debit: 500 }])).toThrow(LedgerError);
    // Its repayment: one debit against two credits of the same amount.
    expect(() =>
      validateJournalLines([
        { account: 'FEE_RECEIVABLE', credit: 200 },
        { account: 'CASH', debit: 200 },
        { account: 'FEE_INCOME', credit: 200 },
      ])
    ).toThrow(/does not balance/);
  });

  it('refuses fractions of a santim, negatives and two-sided lines', () => {
    expect(() => validateJournalLines([{ account: 'CASH', debit: 10.5 }, { account: 'CAPITAL', credit: 10.5 }])).toThrow(/whole number/);
    expect(() => validateJournalLines([{ account: 'CASH', debit: -5 }, { account: 'CAPITAL', credit: -5 }])).toThrow(/negative/);
    expect(() => validateJournalLines([{ account: 'CASH', debit: 5, credit: 5 }, { account: 'CAPITAL', credit: 0 }])).toThrow(/both/);
  });

  it('refuses an empty journal', () => {
    expect(() => validateJournalLines([{ account: 'CASH', debit: 0 }, { account: 'CAPITAL', credit: 0 }])).toThrow(/at least one/);
  });
});

describe('chart of accounts', () => {
  it('has unique codes and keys', () => {
    expect(new Set(SYSTEM_ACCOUNTS.map((a) => a.code)).size).toBe(SYSTEM_ACCOUNTS.length);
    expect(new Set(SYSTEM_ACCOUNTS.map((a) => a.key)).size).toBe(SYSTEM_ACCOUNTS.length);
  });

  it('knows which side each account type grows on', () => {
    expect(isDebitNormal('ASSET')).toBe(true);
    expect(isDebitNormal('EXPENSE')).toBe(true);
    expect(isDebitNormal('LIABILITY')).toBe(false);
    expect(isDebitNormal('EQUITY')).toBe(false);
    expect(isDebitNormal('INCOME')).toBe(false);
  });
});
