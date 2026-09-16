import { describe, expect, it } from 'vitest';
import {
  accrue,
  applyPayment,
  buildSchedule,
  delinquency,
  openLoan,
  quoteLoan,
  repaymentBehavior,
  reversePayment,
  totalOutstanding,
  writeOff,
  type LoanState,
} from './engine';
import { compileTerms, type LoanTerms, type PenaltyRule } from './terms';

const D0 = 20_000; // an arbitrary business day

function terms(overrides: Partial<LoanTerms> = {}): LoanTerms {
  return {
    version: 1,
    currency: 'ETB',
    productCode: 'T',
    productName: 'Test',
    principal: '10000.00',
    durationDays: 30,
    installmentCount: 1,
    serviceFee: { type: 'NONE', value: '0' },
    interest: { type: 'NONE', value: '0', basis: 'SIMPLE', afterMaturity: false },
    penaltyRules: [],
    taxes: [],
    ...overrides,
  };
}

const vat = { name: 'VAT', ratePercent: '15', fee: true, interest: true, penalty: true };

function stepwise(state: LoanState, compiled: ReturnType<typeof compileTerms>, to: number) {
  let current = state;
  while (current.accruedThrough < to) {
    current = accrue(current, compiled, current.accruedThrough + 1).state;
  }
  return current;
}

describe('buildSchedule', () => {
  it('splits principal exactly, remainder on the last installment', () => {
    const lines = buildSchedule(1000, D0, 90, 3);
    expect(lines.map((l) => l.principalDue)).toEqual([333, 333, 334]);
    expect(lines.map((l) => l.dueDay - D0)).toEqual([30, 60, 90]);
  });

  it('puts the final due date exactly at maturity when the term does not divide evenly', () => {
    const lines = buildSchedule(100_00, D0, 31, 3);
    expect(lines.map((l) => l.dueDay - D0)).toEqual([10, 20, 31]);
  });

  it('refuses impossible schedules', () => {
    expect(() => buildSchedule(1000, D0, 2, 3)).toThrow();
    expect(() => buildSchedule(0, D0, 30, 1)).toThrow();
  });
});

describe('a bullet loan with fee, interest, penalties and tax', () => {
  const penaltyRules: PenaltyRule[] = [
    { fromDay: 1, toDay: null, type: 'PERCENT_PRINCIPAL', value: '0.5', frequency: 'DAILY' },
    { fromDay: 1, toDay: 1, type: 'FIXED', value: '100', frequency: 'ONCE' },
  ];
  const compiled = compileTerms(
    terms({
      serviceFee: { type: 'PERCENT', value: '2' },
      interest: { type: 'PERCENT_DAILY', value: '0.1', basis: 'SIMPLE', afterMaturity: false },
      penaltyRules,
      taxes: [vat],
    })
  );

  it('charges the fee and its tax at disbursement', () => {
    const { state, charges } = openLoan(compiled, D0);
    expect(charges).toEqual({ fee: 20_000, taxOnFee: 3_000 });
    expect(totalOutstanding(state)).toBe(1_000_000 + 20_000 + 3_000);
    expect(state.maturityDay).toBe(D0 + 30);
  });

  it('quotes the cost of repaying at maturity', () => {
    const quote = quoteLoan(compiled, D0);
    expect(quote.interest).toBe(30 * 1_000);
    expect(quote.taxOnInterest).toBe(30 * 150);
    expect(quote.totalRepayable).toBe(1_000_000 + 20_000 + 3_000 + 30_000 + 4_500);
  });

  it('does not charge a day of interest for a same-day repayment', () => {
    const { state } = openLoan(compiled, D0);
    expect(accrue(state, compiled, D0).interest).toBe(0);
  });

  it('stops interest at maturity and starts penalties the day after the due date', () => {
    const { state } = openLoan(compiled, D0);
    const atMaturity = accrue(state, compiled, D0 + 30).state;
    expect(atMaturity.interest).toBe(30_000);
    expect(atMaturity.penalty).toBe(0);
    expect(delinquency(atMaturity, D0 + 30).daysPastDue).toBe(0);

    const dayOne = accrue(atMaturity, compiled, D0 + 31);
    expect(dayOne.interest).toBe(0);
    expect(dayOne.penalty).toBe(10_000 + 5_000); // once-off fee + 0.5% of principal
    expect(dayOne.taxOnPenalty).toBe(2_250);
    expect(delinquency(dayOne.state, D0 + 31).daysPastDue).toBe(1);

    const dayThree = accrue(dayOne.state, compiled, D0 + 33);
    expect(dayThree.penalty).toBe(2 * 5_000); // the once-off rule does not repeat
    expect(dayThree.state.penalty).toBe(25_000);
    expect(dayThree.state.maxDaysPastDue).toBe(3);
  });

  it('gives identical balances whether accrued nightly or caught up in one run', () => {
    const { state } = openLoan(compiled, D0);
    const nightly = stepwise(state, compiled, D0 + 75);
    const catchUp = accrue(state, compiled, D0 + 75).state;
    expect(catchUp).toEqual(nightly);
  });

  it('is idempotent for a repeated target day', () => {
    const { state } = openLoan(compiled, D0);
    const once = accrue(state, compiled, D0 + 40).state;
    const twice = accrue(once, compiled, D0 + 40);
    expect(twice.state).toEqual(once);
    expect(twice.interest + twice.penalty).toBe(0);
  });

  it('allocates penalty, then fee, interest, tax, then principal', () => {
    const { state } = openLoan(compiled, D0);
    const overdue = accrue(state, compiled, D0 + 33).state;
    const { state: after, allocation } = applyPayment(overdue, 50_000);
    expect(allocation).toMatchObject({ penalty: 25_000, fee: 20_000, interest: 5_000, tax: 0, principal: 0, excess: 0 });
    expect(after.interest).toBe(25_000);
    expect(after.penalty + after.fee).toBe(0);
    expect(allocation.installments).toEqual([{ number: 1, principal: 0, penalty: 25_000 }]);
  });
});

describe('prepayment', () => {
  const compiled = compileTerms(
    terms({
      serviceFee: { type: 'PERCENT', value: '2' },
      interest: { type: 'PERCENT_DAILY', value: '0.1', basis: 'SIMPLE', afterMaturity: false },
      taxes: [vat],
    })
  );

  it('reduces the interest charged from the next day on', () => {
    const { state } = openLoan(compiled, D0);
    const day10 = accrue(state, compiled, D0 + 10).state;
    // fee 200.00 + interest 100.00 + tax (30.00 + 15.00) + 5,000.00 of principal
    const paid = applyPayment(day10, 20_000 + 10_000 + 4_500 + 500_000);
    expect(paid.allocation.principal).toBe(500_000);

    const maturity = accrue(paid.state, compiled, D0 + 30);
    expect(maturity.interest).toBe(20 * 500);
    expect(maturity.state.interestAccrued).toBe(10_000 + 10_000);
  });

  it('closes the loan on full payoff and keeps any excess as a credit', () => {
    const { state } = openLoan(compiled, D0);
    const day5 = accrue(state, compiled, D0 + 5).state;
    const owed = totalOutstanding(day5);
    const { state: closed, allocation } = applyPayment(day5, owed + 1_234);
    expect(closed.status).toBe('PAID_OFF');
    expect(allocation.excess).toBe(1_234);
    expect(closed.credit).toBe(1_234);
    expect(repaymentBehavior(closed, D0 + 5)).toBe('EARLY');

    // Nothing accrues on a closed loan.
    expect(accrue(closed, compiled, D0 + 60).state).toEqual({ ...closed, accruedThrough: closed.accruedThrough });
  });

  it('reverses a payment exactly', () => {
    const { state } = openLoan(compiled, D0);
    const day5 = accrue(state, compiled, D0 + 5).state;
    const { state: closed, allocation } = applyPayment(day5, totalOutstanding(day5) + 500);
    const restored = reversePayment(closed, allocation);
    expect(restored).toEqual(day5);
  });

  it('refuses a payment on a closed loan', () => {
    const { state } = openLoan(compiled, D0);
    const { state: closed } = applyPayment(state, totalOutstanding(state));
    expect(() => applyPayment(closed, 100)).toThrow();
  });
});

describe('interest variants', () => {
  it('compounds on unpaid interest', () => {
    const compiled = compileTerms(
      terms({
        principal: '1000.00',
        interest: { type: 'PERCENT_DAILY', value: '1', basis: 'COMPOUND', afterMaturity: false },
      })
    );
    const { state } = openLoan(compiled, D0);
    expect(accrue(state, compiled, D0 + 3).interest).toBe(1_000 + 1_010 + 1_020);
  });

  it('charges a fixed daily amount until the principal is repaid', () => {
    const compiled = compileTerms(
      terms({ interest: { type: 'FIXED_DAILY', value: '7.50', basis: 'SIMPLE', afterMaturity: false } })
    );
    const { state } = openLoan(compiled, D0);
    const day4 = accrue(state, compiled, D0 + 4).state;
    expect(day4.interest).toBe(4 * 750);
    const { state: closed } = applyPayment(day4, totalOutstanding(day4));
    expect(accrue(closed, compiled, D0 + 10).interest).toBe(0);
  });

  it('keeps charging after maturity only when the product says so', () => {
    const base = { type: 'PERCENT_DAILY' as const, value: '0.1', basis: 'SIMPLE' as const };
    const stops = compileTerms(terms({ interest: { ...base, afterMaturity: false } }));
    const continues = compileTerms(terms({ interest: { ...base, afterMaturity: true } }));
    expect(accrue(openLoan(stops, D0).state, stops, D0 + 40).interest).toBe(30 * 1_000);
    expect(accrue(openLoan(continues, D0).state, continues, D0 + 40).interest).toBe(40 * 1_000);
  });
});

describe('installment loans', () => {
  const compiled = compileTerms(
    terms({
      principal: '9000.00',
      durationDays: 90,
      installmentCount: 3,
      penaltyRules: [
        { fromDay: 1, toDay: null, type: 'PERCENT_PRINCIPAL', value: '1', frequency: 'DAILY' },
      ],
    })
  );

  it('charges penalties only on the installment that is overdue', () => {
    const { state } = openLoan(compiled, D0);
    const late = accrue(state, compiled, D0 + 32).state;
    expect(late.penalty).toBe(2 * 3_000);
    expect(late.installments.map((i) => i.penaltyAccrued)).toEqual([6_000, 0, 0]);
    expect(delinquency(late, D0 + 32)).toEqual({
      daysPastDue: 2,
      overduePrincipal: 300_000,
      overdueInstallments: 1,
    });
  });

  it('clears arrears when the overdue installment is paid, and moves on to the next', () => {
    const { state } = openLoan(compiled, D0);
    const late = accrue(state, compiled, D0 + 32).state;
    const { state: cured, allocation } = applyPayment(late, 306_000);
    expect(allocation.installments).toEqual([{ number: 1, principal: 300_000, penalty: 6_000 }]);
    expect(delinquency(cured, D0 + 32).daysPastDue).toBe(0);

    const secondLate = accrue(cured, compiled, D0 + 62).state;
    expect(secondLate.installments.map((i) => i.penaltyAccrued)).toEqual([6_000, 6_000, 0]);
    expect(secondLate.maxDaysPastDue).toBe(2);
  });

  it('counts days past due from the oldest unpaid installment', () => {
    const { state } = openLoan(compiled, D0);
    const veryLate = accrue(state, compiled, D0 + 65).state;
    expect(delinquency(veryLate, D0 + 65)).toMatchObject({
      daysPastDue: 35,
      overduePrincipal: 600_000,
      overdueInstallments: 2,
    });
  });
});

describe('penalty variants', () => {
  it('compounds a balance-based penalty on its own unpaid penalty', () => {
    const compiled = compileTerms(
      terms({
        principal: '1000.00',
        durationDays: 1,
        penaltyRules: [
          { fromDay: 1, toDay: null, type: 'PERCENT_BALANCE', value: '10', frequency: 'DAILY' },
        ],
      })
    );
    const { state } = openLoan(compiled, D0);
    expect(accrue(state, compiled, D0 + 3).penalty).toBe(10_000 + 11_000);
  });

  it('honours day bands', () => {
    const compiled = compileTerms(
      terms({
        principal: '1000.00',
        durationDays: 1,
        penaltyRules: [
          { fromDay: 1, toDay: 5, type: 'FIXED', value: '1', frequency: 'DAILY' },
          { fromDay: 6, toDay: null, type: 'FIXED', value: '2', frequency: 'DAILY' },
          { fromDay: 30, toDay: null, type: 'FIXED', value: '50', frequency: 'ONCE' },
        ],
      })
    );
    const { state } = openLoan(compiled, D0);
    // Day 1 past due is D0+1's end. Accrue through day 10 past due.
    const result = accrue(state, compiled, D0 + 1 + 10);
    expect(result.penalty).toBe(5 * 100 + 5 * 200);
    const later = accrue(result.state, compiled, D0 + 1 + 30);
    expect(later.penalty).toBe(20 * 200 + 5_000);
  });
});

describe('write-off', () => {
  it('removes every outstanding balance and stops accrual', () => {
    const compiled = compileTerms(
      terms({ interest: { type: 'PERCENT_DAILY', value: '0.1', basis: 'SIMPLE', afterMaturity: true } })
    );
    const { state } = openLoan(compiled, D0);
    const old = accrue(state, compiled, D0 + 100).state;
    const { state: gone, amounts } = writeOff(old);
    expect(amounts.principal).toBe(1_000_000);
    expect(amounts.interest).toBe(100 * 1_000);
    expect(totalOutstanding(gone)).toBe(0);
    expect(gone.status).toBe('WRITTEN_OFF');
    expect(accrue(gone, compiled, D0 + 200).interest).toBe(0);
  });
});
