import { applyRate, type Cents } from '@/lib/money';
import type { Day } from '@/lib/business-date';
import type { CompiledTerms } from './terms';

/**
 * The loan engine: every number a loan owes comes out of these functions.
 *
 * It is pure — no database, no clock — so the nightly accrual job, a repayment,
 * the admin console and the borrower's calculator all get identical answers.
 * The previous system had four separate penalty implementations that
 * disagreed with one another, and the ledger was posted from one while the
 * screen showed another.
 *
 * The model:
 *
 *  - A loan is a principal split into one or more installments. A bullet loan
 *    is simply a loan with one installment due at maturity, so there is one
 *    code path, not two.
 *  - Interest accrues for each *completed* business day from disbursement until
 *    maturity (or beyond, if the product says so), on the principal still
 *    outstanding — or on principal plus unpaid interest for compound products.
 *  - Penalties accrue per overdue installment. Day 1 past due is the day after
 *    the due date. Each rule applies to a band of days past due, once or daily,
 *    as a fixed amount or a percentage of the installment's unpaid principal
 *    (or principal plus unpaid penalty, which compounds).
 *  - Tax is charged on the fee, interest and penalty it is configured for, at
 *    the moment each is charged, and rounded per charge. Because rounding
 *    happens per day, a loan accrued nightly and a loan caught up after a
 *    month-long outage end up with exactly the same balances.
 *  - A payment is applied in a fixed order — penalty, service fee, interest,
 *    tax, principal — with penalties and principal settled oldest installment
 *    first. Anything left over is a credit owed back to the borrower; it is
 *    never silently discarded.
 */

export type EngineLoanStatus = 'ACTIVE' | 'PAID_OFF' | 'WRITTEN_OFF';

export interface InstallmentState {
  number: number;
  dueDay: Day;
  principalDue: Cents;
  principalPaid: Cents;
  penaltyAccrued: Cents;
  penaltyPaid: Cents;
}

export interface LoanState {
  status: EngineLoanStatus;
  disbursementDay: Day;
  maturityDay: Day;
  /** Exclusive: days before this one have been accrued. */
  accruedThrough: Day;

  principal: Cents;
  interest: Cents;
  fee: Cents;
  penalty: Cents;
  tax: Cents;
  credit: Cents;

  interestAccrued: Cents;
  feeCharged: Cents;
  penaltyAccrued: Cents;
  taxAccrued: Cents;

  principalPaid: Cents;
  interestPaid: Cents;
  feePaid: Cents;
  penaltyPaid: Cents;
  taxPaid: Cents;
  writtenOff: Cents;

  maxDaysPastDue: number;
  installments: InstallmentState[];
}

export interface ScheduleLine {
  number: number;
  dueDay: Day;
  principalDue: Cents;
}

export class EngineError extends Error {}

function cloneState(state: LoanState): LoanState {
  return { ...state, installments: state.installments.map((i) => ({ ...i })) };
}

/**
 * Due dates at even intervals, the last one exactly at maturity. Principal is
 * split evenly in whole santim with the remainder on the final installment, so
 * the installments always add back up to the principal.
 */
export function buildSchedule(
  principal: Cents,
  disbursementDay: Day,
  durationDays: number,
  installmentCount: number
): ScheduleLine[] {
  const count = Math.max(1, Math.floor(installmentCount));
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new EngineError('A loan must run for at least one day.');
  }
  if (count > durationDays) {
    throw new EngineError('There cannot be more installments than days in the term.');
  }
  if (!Number.isSafeInteger(principal) || principal <= 0) {
    throw new EngineError('Principal must be a positive amount.');
  }

  const interval = Math.floor(durationDays / count);
  const perInstallment = Math.floor(principal / count);
  const lines: ScheduleLine[] = [];
  let allocated = 0;

  for (let n = 1; n <= count; n += 1) {
    const last = n === count;
    const principalDue = last ? principal - allocated : perInstallment;
    allocated += principalDue;
    lines.push({
      number: n,
      dueDay: last ? disbursementDay + durationDays : disbursementDay + interval * n,
      principalDue,
    });
  }
  return lines;
}

export interface OpeningCharges {
  fee: Cents;
  taxOnFee: Cents;
}

/** A loan on the day its money leaves the provider. */
export function openLoan(
  terms: CompiledTerms,
  disbursementDay: Day
): { state: LoanState; charges: OpeningCharges } {
  const schedule = buildSchedule(
    terms.principal,
    disbursementDay,
    terms.durationDays,
    terms.installmentCount
  );

  const fee = terms.feeFixed + applyRate(terms.principal, terms.feeRateMicro);
  const taxOnFee = applyRate(fee, terms.taxOnFeeMicro);

  const state: LoanState = {
    status: 'ACTIVE',
    disbursementDay,
    maturityDay: disbursementDay + terms.durationDays,
    accruedThrough: disbursementDay,
    principal: terms.principal,
    interest: 0,
    fee,
    penalty: 0,
    tax: taxOnFee,
    credit: 0,
    interestAccrued: 0,
    feeCharged: fee,
    penaltyAccrued: 0,
    taxAccrued: taxOnFee,
    principalPaid: 0,
    interestPaid: 0,
    feePaid: 0,
    penaltyPaid: 0,
    taxPaid: 0,
    writtenOff: 0,
    maxDaysPastDue: 0,
    installments: schedule.map((line) => ({
      number: line.number,
      dueDay: line.dueDay,
      principalDue: line.principalDue,
      principalPaid: 0,
      penaltyAccrued: 0,
      penaltyPaid: 0,
    })),
  };

  return { state, charges: { fee, taxOnFee } };
}

export interface AccrualResult {
  state: LoanState;
  interest: Cents;
  penalty: Cents;
  taxOnInterest: Cents;
  taxOnPenalty: Cents;
  fromDay: Day;
  toDay: Day;
}

/**
 * Advances the loan to `toDay`, charging every day in [accruedThrough, toDay).
 * Calling it twice with the same target changes nothing the second time, and
 * accruing to day N in several steps gives exactly what one step gives.
 */
export function accrue(input: LoanState, terms: CompiledTerms, toDay: Day): AccrualResult {
  const state = cloneState(input);
  const fromDay = state.accruedThrough;
  const result: AccrualResult = {
    state,
    interest: 0,
    penalty: 0,
    taxOnInterest: 0,
    taxOnPenalty: 0,
    fromDay,
    toDay: Math.max(toDay, fromDay),
  };

  if (state.status !== 'ACTIVE' || toDay <= fromDay) {
    return result;
  }

  const chargesInterest = terms.interestType !== 'NONE';
  const chargesPenalty = terms.penalties.length > 0;

  for (let day = fromDay; day < toDay; day += 1) {
    if (state.principal <= 0) break;

    // --- interest for the day that just ended ---
    if (chargesInterest && (day < state.maturityDay || terms.afterMaturity)) {
      let amount = 0;
      if (terms.interestType === 'FIXED_DAILY') {
        amount = terms.interestFixed;
      } else {
        const base = terms.compound ? state.principal + state.interest : state.principal;
        amount = applyRate(base, terms.interestRateMicro);
      }
      if (amount > 0) {
        const tax = applyRate(amount, terms.taxOnInterestMicro);
        state.interest += amount;
        state.interestAccrued += amount;
        state.tax += tax;
        state.taxAccrued += tax;
        result.interest += amount;
        result.taxOnInterest += tax;
      }
    }

    // --- penalties for installments overdue as of the next day ---
    if (chargesPenalty) {
      let penaltyToday = 0;
      for (const installment of state.installments) {
        const unpaidPrincipal = installment.principalDue - installment.principalPaid;
        if (unpaidPrincipal <= 0 || day < installment.dueDay) continue;

        const daysOverdue = day + 1 - installment.dueDay;
        const unpaidPenalty = installment.penaltyAccrued - installment.penaltyPaid;
        let charge = 0;

        for (const rule of terms.penalties) {
          if (daysOverdue < rule.fromDay || daysOverdue > rule.toDay) continue;
          if (rule.once && daysOverdue !== rule.fromDay) continue;
          if (rule.type === 'FIXED') charge += rule.fixed;
          else if (rule.type === 'PERCENT_PRINCIPAL') charge += applyRate(unpaidPrincipal, rule.rateMicro);
          else charge += applyRate(unpaidPrincipal + unpaidPenalty, rule.rateMicro);
        }

        if (charge > 0) {
          installment.penaltyAccrued += charge;
          penaltyToday += charge;
        }
      }

      if (penaltyToday > 0) {
        const tax = applyRate(penaltyToday, terms.taxOnPenaltyMicro);
        state.penalty += penaltyToday;
        state.penaltyAccrued += penaltyToday;
        state.tax += tax;
        state.taxAccrued += tax;
        result.penalty += penaltyToday;
        result.taxOnPenalty += tax;
      }
    }
  }

  state.accruedThrough = toDay;
  state.maxDaysPastDue = Math.max(state.maxDaysPastDue, delinquency(state, toDay).daysPastDue);
  return result;
}

export interface Delinquency {
  daysPastDue: number;
  overduePrincipal: Cents;
  overdueInstallments: number;
}

/** Arrears as of the start of `asOfDay`. */
export function delinquency(state: LoanState, asOfDay: Day): Delinquency {
  let oldestDue: Day | null = null;
  let overduePrincipal = 0;
  let overdueInstallments = 0;

  if (state.status === 'ACTIVE') {
    for (const installment of state.installments) {
      const unpaid = installment.principalDue - installment.principalPaid;
      if (unpaid <= 0 || installment.dueDay >= asOfDay) continue;
      overduePrincipal += unpaid;
      overdueInstallments += 1;
      if (oldestDue === null || installment.dueDay < oldestDue) oldestDue = installment.dueDay;
    }
  }

  return {
    daysPastDue: oldestDue === null ? 0 : asOfDay - oldestDue,
    overduePrincipal,
    overdueInstallments,
  };
}

export function totalOutstanding(state: LoanState): Cents {
  return state.principal + state.interest + state.fee + state.penalty + state.tax;
}

export interface InstallmentAllocation {
  number: number;
  principal: Cents;
  penalty: Cents;
}

export interface PaymentAllocation {
  amount: Cents;
  penalty: Cents;
  fee: Cents;
  interest: Cents;
  tax: Cents;
  principal: Cents;
  excess: Cents;
  installments: InstallmentAllocation[];
}

/**
 * Applies a payment to a loan that has already been accrued to the payment's
 * value date. Returns the new state and exactly where every santim went — the
 * repayment journal is built from this allocation and nothing else.
 */
export function applyPayment(
  input: LoanState,
  amount: Cents
): { state: LoanState; allocation: PaymentAllocation } {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new EngineError('A payment must be a positive amount.');
  }
  if (input.status !== 'ACTIVE') {
    throw new EngineError('Payments can only be applied to an active loan.');
  }

  const state = cloneState(input);
  let remaining = amount;
  const byInstallment = new Map<number, InstallmentAllocation>();
  const touch = (number: number) => {
    let entry = byInstallment.get(number);
    if (!entry) {
      entry = { number, principal: 0, penalty: 0 };
      byInstallment.set(number, entry);
    }
    return entry;
  };

  const ordered = [...state.installments].sort((a, b) => a.number - b.number);

  // 1. Penalty, oldest installment first.
  let penaltyPaid = 0;
  for (const installment of ordered) {
    if (remaining <= 0) break;
    const owed = installment.penaltyAccrued - installment.penaltyPaid;
    if (owed <= 0) continue;
    const pay = Math.min(owed, remaining);
    installment.penaltyPaid += pay;
    touch(installment.number).penalty += pay;
    penaltyPaid += pay;
    remaining -= pay;
  }
  state.penalty -= penaltyPaid;
  state.penaltyPaid += penaltyPaid;

  // 2–4. Service fee, interest, tax.
  const take = (owed: Cents) => {
    const pay = Math.min(Math.max(0, owed), remaining);
    remaining -= pay;
    return pay;
  };
  const feePaid = take(state.fee);
  state.fee -= feePaid;
  state.feePaid += feePaid;

  const interestPaid = take(state.interest);
  state.interest -= interestPaid;
  state.interestPaid += interestPaid;

  const taxPaid = take(state.tax);
  state.tax -= taxPaid;
  state.taxPaid += taxPaid;

  // 5. Principal, oldest installment first. Paying ahead is allowed and
  //    reduces the interest charged from the next day on.
  let principalPaid = 0;
  for (const installment of ordered) {
    if (remaining <= 0) break;
    const owed = installment.principalDue - installment.principalPaid;
    if (owed <= 0) continue;
    const pay = Math.min(owed, remaining);
    installment.principalPaid += pay;
    touch(installment.number).principal += pay;
    principalPaid += pay;
    remaining -= pay;
  }
  state.principal -= principalPaid;
  state.principalPaid += principalPaid;

  // 6. Whatever is left is owed back to the borrower.
  const excess = remaining;
  state.credit += excess;

  if (totalOutstanding(state) === 0) state.status = 'PAID_OFF';

  return {
    state,
    allocation: {
      amount,
      penalty: penaltyPaid,
      fee: feePaid,
      interest: interestPaid,
      tax: taxPaid,
      principal: principalPaid,
      excess,
      installments: [...byInstallment.values()].sort((a, b) => a.number - b.number),
    },
  };
}

/**
 * Undoes a payment's allocation. Accruals already charged since are not
 * recomputed: a reversal restores what is owed from today on, it does not
 * rewrite history the ledger has already recorded.
 */
export function reversePayment(input: LoanState, allocation: PaymentAllocation): LoanState {
  if (input.status === 'WRITTEN_OFF') {
    throw new EngineError('A payment on a written-off loan cannot be reversed.');
  }
  if (input.credit < allocation.excess) {
    throw new EngineError(
      'The overpayment from this receipt has already been refunded; reverse the refund first.'
    );
  }

  const state = cloneState(input);
  const byNumber = new Map(state.installments.map((i) => [i.number, i]));

  for (const line of allocation.installments) {
    const installment = byNumber.get(line.number);
    if (!installment) throw new EngineError(`Installment ${line.number} does not exist.`);
    if (installment.principalPaid < line.principal || installment.penaltyPaid < line.penalty) {
      throw new EngineError('The allocation does not match the loan it is being reversed on.');
    }
    installment.principalPaid -= line.principal;
    installment.penaltyPaid -= line.penalty;
  }

  state.penalty += allocation.penalty;
  state.penaltyPaid -= allocation.penalty;
  state.fee += allocation.fee;
  state.feePaid -= allocation.fee;
  state.interest += allocation.interest;
  state.interestPaid -= allocation.interest;
  state.tax += allocation.tax;
  state.taxPaid -= allocation.tax;
  state.principal += allocation.principal;
  state.principalPaid -= allocation.principal;
  state.credit -= allocation.excess;

  if (state.status === 'PAID_OFF' && totalOutstanding(state) > 0) state.status = 'ACTIVE';
  return state;
}

export interface WriteOffAmounts {
  principal: Cents;
  interest: Cents;
  fee: Cents;
  penalty: Cents;
  tax: Cents;
}

/** Removes everything still owed from the books. */
export function writeOff(input: LoanState): { state: LoanState; amounts: WriteOffAmounts } {
  if (input.status !== 'ACTIVE') {
    throw new EngineError('Only an active loan can be written off.');
  }
  const state = cloneState(input);
  const amounts: WriteOffAmounts = {
    principal: state.principal,
    interest: state.interest,
    fee: state.fee,
    penalty: state.penalty,
    tax: state.tax,
  };
  state.writtenOff = state.principal;
  state.principal = 0;
  state.interest = 0;
  state.fee = 0;
  state.penalty = 0;
  state.tax = 0;
  state.status = 'WRITTEN_OFF';
  return { state, amounts };
}

export type RepaymentBehavior = 'EARLY' | 'ON_TIME' | 'LATE';

export function repaymentBehavior(state: LoanState, payoffDay: Day): RepaymentBehavior {
  if (state.maxDaysPastDue > 0 || payoffDay > state.maturityDay) return 'LATE';
  return payoffDay < state.maturityDay ? 'EARLY' : 'ON_TIME';
}

export interface LoanQuote {
  principal: Cents;
  fee: Cents;
  taxOnFee: Cents;
  interest: Cents;
  taxOnInterest: Cents;
  totalRepayable: Cents;
  maturityDay: Day;
  schedule: ScheduleLine[];
}

/** What a loan costs if repaid exactly at maturity — the calculator's answer. */
export function quoteLoan(terms: CompiledTerms, disbursementDay: Day): LoanQuote {
  const { state, charges } = openLoan(terms, disbursementDay);
  const accrued = accrue(state, terms, state.maturityDay);
  return {
    principal: terms.principal,
    fee: charges.fee,
    taxOnFee: charges.taxOnFee,
    interest: accrued.interest,
    taxOnInterest: accrued.taxOnInterest,
    totalRepayable:
      terms.principal + charges.fee + charges.taxOnFee + accrued.interest + accrued.taxOnInterest,
    maturityDay: state.maturityDay,
    schedule: state.installments.map((i) => ({
      number: i.number,
      dueDay: i.dueDay,
      principalDue: i.principalDue,
    })),
  };
}
