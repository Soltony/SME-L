import { describe, expect, it } from 'vitest';
import { parseCbsDate, parseCustomerInfo, parseStatement, type CbsStatementLine } from '@/lib/integrations/core-banking';
import { monthWindow, profileIsCurrent, summarizeCustomer, summarizeStatements, PROFILE_MAX_AGE_MS, RETRY_AFTER_FAILURE_MS } from './core-banking-profile';

const line = (date: string, credit: number, debit: number, balance: number | null, counterparty: string | null = null): CbsStatementLine => ({
  date,
  credit,
  debit,
  balance,
  counterparty,
});

describe('parseCbsDate', () => {
  it('reads the formats core banking answers with', () => {
    for (const text of ['20250104', '2025-01-04', '04 JAN 25', '04-JAN-2025', '4 January 2025', '04/01/2025']) {
      expect(parseCbsDate(text)).toBe('2025-01-04');
    }
  });

  it('refuses dates that do not exist', () => {
    expect(parseCbsDate('20250230')).toBeNull();
    expect(parseCbsDate('31 FOO 25')).toBeNull();
    expect(parseCbsDate('')).toBeNull();
  });
});

describe('response parsing', () => {
  it('reads the customer record from its envelope, keeping only what scoring uses', () => {
    const info = parseCustomerInfo({
      detail: { NetMonthlyIncome: '12,500.00', DateOfBirth: '15 MAR 90', AccountOpeningDate: '20180601', Occupation: ' Trader ', MotherName: 'x', NationalId: '123' },
    });
    expect(info).toEqual({ netMonthlyIncome: 12500, dateOfBirth: '1990-03-15', accountOpeningDate: '2018-06-01', occupation: 'Trader', region: null, city: null });
  });

  it('reads statement lines, whichever envelope and casing', () => {
    const lines = parseStatement({
      details: { statementDetails: [{ ValueDate: '10 FEB 25', Credit: '1,000.00', Debit: null, ClosingBalance: '5,000', Reference: 'ABC Trading' }] },
    });
    expect(lines).toEqual([{ date: '2025-02-10', credit: 1000, debit: 0, balance: 5000, counterparty: 'ABC Trading' }]);
    expect(parseStatement({ nothing: true })).toEqual([]);
  });
});

describe('summarizeStatements', () => {
  const end = '2025-06-20';

  it('covers the six calendar months up to the current one', () => {
    expect(monthWindow(end)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']);
  });

  it('takes the median month, so one windfall does not inflate deposits', () => {
    const lines = ['01', '02', '03', '04', '05'].map((m) => line(`2025-${m}-10`, 10_000, 4_000, null, 'Shop'));
    lines.push(line('2025-06-10', 500_000, 0, null, 'Land sale'));
    const summary = summarizeStatements([lines], end);
    expect(summary.avgMonthlyDeposit).toBe(10_000);
    expect(summary.activeMonths).toBe(6);
    expect(summary.depositCount).toBe(6);
    expect(summary.depositSources).toBe(2);
    expect(summary.withdrawalToDepositPercent).toBe(Math.round((20_000 / 550_000) * 100));
  });

  it('ignores lines outside the window and counts quiet months as zero', () => {
    const summary = summarizeStatements([[line('2024-12-31', 99_000, 0, 1), line('2025-06-01', 6_000, 0, 6_000)]], end);
    expect(summary.avgMonthlyDeposit).toBe(0);
    expect(summary.activeMonths).toBe(1);
  });

  it('adds balances across accounts at each month end, carrying a quiet month forward', () => {
    const a = [line('2025-01-05', 0, 0, 1_000), line('2025-03-05', 0, 0, 3_000)];
    const b = [line('2025-01-20', 0, 0, 500)];
    const summary = summarizeStatements([a, b], end);
    // Jan 1500, Feb 1500, Mar 3500, Apr–Jun 3500.
    expect(summary.lowestBalance).toBe(1_500);
    expect(summary.avgBalance).toBe(Math.round(((1_500 * 2 + 3_500 * 4) / 6) * 100) / 100);
  });

  it('leaves balance and ratio out when the bank gave none', () => {
    const summary = summarizeStatements([[]], end);
    expect(summary).not.toHaveProperty('avgBalance');
    expect(summary).not.toHaveProperty('withdrawalToDepositPercent');
  });
});

describe('summarizeCustomer', () => {
  const base = { netMonthlyIncome: null, dateOfBirth: null, accountOpeningDate: null, occupation: null, region: null, city: null };

  it('works out age and time with the bank from the oldest account', () => {
    const summary = summarizeCustomer(
      [
        { ...base, dateOfBirth: '1990-06-21', accountOpeningDate: '2020-01-15', netMonthlyIncome: 9000 },
        { ...base, accountOpeningDate: '2019-06-20', occupation: 'Trader' },
      ],
      '2025-06-20'
    );
    expect(summary).toEqual({ netMonthlyIncome: 9000, ageYears: 34, accountAgeMonths: 72, occupation: 'Trader' });
  });
});

describe('profileIsCurrent', () => {
  const now = new Date('2025-06-20T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('keeps a complete profile for a day', () => {
    expect(profileIsCurrent({ fetchedAt: ago(PROFILE_MAX_AGE_MS - 1000), attemptedAt: ago(PROFILE_MAX_AGE_MS - 1000), lastError: null }, now)).toBe(true);
    expect(profileIsCurrent({ fetchedAt: ago(PROFILE_MAX_AGE_MS + 1000), attemptedAt: ago(PROFILE_MAX_AGE_MS + 1000), lastError: null }, now)).toBe(false);
  });

  it('asks the bank again ten minutes after a failure, however recent the last good read', () => {
    const recentGood = ago(60_000);
    expect(profileIsCurrent({ fetchedAt: recentGood, attemptedAt: ago(RETRY_AFTER_FAILURE_MS - 1000), lastError: 'down' }, now)).toBe(true);
    expect(profileIsCurrent({ fetchedAt: recentGood, attemptedAt: ago(RETRY_AFTER_FAILURE_MS + 1000), lastError: 'down' }, now)).toBe(false);
    expect(profileIsCurrent(null, now)).toBe(false);
  });
});
