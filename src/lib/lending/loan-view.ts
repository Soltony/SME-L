import type { Loan, LoanInstallment, LoanProduct, LoanProvider, Repayment } from '@prisma/client';
import { centsToNumber, toCents } from '@/lib/money';
import { dayFromDate, dayToIso, today } from '@/lib/business-date';
import { accrue, delinquency, totalOutstanding, type LoanState } from './engine';
import { compileTerms, parseTerms, type LoanTerms } from './terms';
import { isEngineManaged, stateFromRow } from './loan-store';

/**
 * What a loan owes right now, for display.
 *
 * Stored balances are current to the last accrual (normally last night). The
 * gap to today — usually zero or one day — is accrued in memory here, so every
 * screen shows today's figure without writing anything. The previous system
 * replayed each loan's entire history from its first day on every page load,
 * for every loan on the page, which is why the dashboard slowed as the book
 * grew — and it did so with a different formula from the one the ledger used.
 */

export type InstallmentStatus = 'PAID' | 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING' | 'WRITTEN_OFF';

export interface InstallmentView {
  number: number;
  dueDate: string;
  principalDue: number;
  principalPaid: number;
  penaltyAccrued: number;
  penaltyPaid: number;
  status: InstallmentStatus;
}

export interface LoanView {
  id: string;
  loanNumber: string;
  status: string;
  productName: string;
  providerName: string;
  currency: string;
  principal: number;
  disbursementAccount: string;
  disbursementDate: string | null;
  maturityDate: string | null;
  asOf: string;
  accruedThrough: string | null;
  outstanding: {
    principal: number;
    interest: number;
    fee: number;
    penalty: number;
    tax: number;
    total: number;
  };
  credit: number;
  lifetime: {
    interestAccrued: number;
    feeCharged: number;
    penaltyAccrued: number;
    taxAccrued: number;
    principalPaid: number;
    interestPaid: number;
    feePaid: number;
    penaltyPaid: number;
    taxPaid: number;
    writtenOff: number;
  };
  daysPastDue: number;
  overduePrincipal: number;
  /** What must be paid today to clear all arrears (overdue principal plus every charge owed). */
  amountDueNow: number;
  nextInstallment: { number: number; dueDate: string; amount: number } | null;
  installments: InstallmentView[];
  terms: LoanTerms;
  repaymentBehavior: string | null;
  createdAt: string;
  closedAt: string | null;
}

type LoanRow = Loan & {
  installments: LoanInstallment[];
  product: Pick<LoanProduct, 'name'>;
  provider: Pick<LoanProvider, 'name'>;
};

export function projectState(loan: Loan & { installments: LoanInstallment[] }, asOfDay = today()): LoanState | null {
  if (!isEngineManaged(loan.status)) return null;
  const state = stateFromRow(loan);
  if (state.status !== 'ACTIVE' || asOfDay <= state.accruedThrough) return state;
  return accrue(state, compileTerms(parseTerms(loan.terms)), asOfDay).state;
}

export function buildLoanView(loan: LoanRow, asOfDay = today()): LoanView {
  const terms = parseTerms(loan.terms);
  const state = projectState(loan, asOfDay);
  const n = centsToNumber;

  const installments: InstallmentView[] = (state?.installments ?? []).map((i) => {
    const settled = i.principalPaid >= i.principalDue && i.penaltyPaid >= i.penaltyAccrued;
    // A closed loan asks nothing more of the borrower, so its unpaid rows are not "overdue".
    const status: InstallmentStatus = settled
      ? 'PAID'
      : state?.status === 'WRITTEN_OFF'
        ? 'WRITTEN_OFF'
        : i.dueDay < asOfDay
        ? 'OVERDUE'
        : i.dueDay === asOfDay
          ? 'DUE_TODAY'
          : 'UPCOMING';
    return {
      number: i.number,
      dueDate: dayToIso(i.dueDay),
      principalDue: n(i.principalDue),
      principalPaid: n(i.principalPaid),
      penaltyAccrued: n(i.penaltyAccrued),
      penaltyPaid: n(i.penaltyPaid),
      status,
    };
  });

  const arrears = state ? delinquency(state, asOfDay) : { daysPastDue: 0, overduePrincipal: 0 };
  const charges = state ? state.interest + state.fee + state.penalty + state.tax : 0;
  const next =
    state?.status === 'ACTIVE'
      ? state.installments.find((i) => i.principalPaid < i.principalDue && i.dueDay >= asOfDay)
      : undefined;

  return {
    id: loan.id,
    loanNumber: loan.loanNumber,
    status: state?.status ?? loan.status,
    productName: loan.product.name,
    providerName: loan.provider.name,
    currency: terms.currency,
    principal: n(toCents(loan.principalAmount)),
    disbursementAccount: loan.disbursementAccount,
    disbursementDate: loan.disbursementDate ? dayToIso(dayFromDate(loan.disbursementDate)) : null,
    maturityDate: loan.maturityDate ? dayToIso(dayFromDate(loan.maturityDate)) : null,
    asOf: dayToIso(asOfDay),
    accruedThrough: loan.accruedThrough ? dayToIso(dayFromDate(loan.accruedThrough)) : null,
    outstanding: {
      principal: n(state?.principal ?? 0),
      interest: n(state?.interest ?? 0),
      fee: n(state?.fee ?? 0),
      penalty: n(state?.penalty ?? 0),
      tax: n(state?.tax ?? 0),
      total: n(state ? totalOutstanding(state) : 0),
    },
    credit: n(state?.credit ?? toCents(loan.creditBalance)),
    lifetime: {
      interestAccrued: n(state?.interestAccrued ?? 0),
      feeCharged: n(state?.feeCharged ?? 0),
      penaltyAccrued: n(state?.penaltyAccrued ?? 0),
      taxAccrued: n(state?.taxAccrued ?? 0),
      principalPaid: n(state?.principalPaid ?? 0),
      interestPaid: n(state?.interestPaid ?? 0),
      feePaid: n(state?.feePaid ?? 0),
      penaltyPaid: n(state?.penaltyPaid ?? 0),
      taxPaid: n(state?.taxPaid ?? 0),
      writtenOff: n(state?.writtenOff ?? 0),
    },
    daysPastDue: arrears.daysPastDue,
    overduePrincipal: n(arrears.overduePrincipal),
    amountDueNow: n(arrears.overduePrincipal + (arrears.overduePrincipal > 0 ? charges : 0)),
    nextInstallment: next
      ? { number: next.number, dueDate: dayToIso(next.dueDay), amount: n(next.principalDue - next.principalPaid) }
      : null,
    installments,
    terms,
    repaymentBehavior: loan.repaymentBehavior,
    createdAt: loan.createdAt.toISOString(),
    closedAt: loan.closedAt?.toISOString() ?? null,
  };
}

export interface RepaymentView {
  id: string;
  receiptNo: string;
  amount: number;
  valueDate: string;
  channel: string;
  status: string;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  tax: number;
  excess: number;
  externalReference: string | null;
  reversalReason: string | null;
  receivedAt: string;
}

export function buildRepaymentView(r: Repayment): RepaymentView {
  return {
    id: r.id,
    receiptNo: r.receiptNo,
    amount: centsToNumber(toCents(r.amount)),
    valueDate: dayToIso(dayFromDate(r.valueDate)),
    channel: r.channel,
    status: r.status,
    principal: centsToNumber(toCents(r.principalPortion)),
    interest: centsToNumber(toCents(r.interestPortion)),
    fee: centsToNumber(toCents(r.feePortion)),
    penalty: centsToNumber(toCents(r.penaltyPortion)),
    tax: centsToNumber(toCents(r.taxPortion)),
    excess: centsToNumber(toCents(r.excessPortion)),
    externalReference: r.externalReference,
    reversalReason: r.reversalReason,
    receivedAt: r.receivedAt.toISOString(),
  };
}
