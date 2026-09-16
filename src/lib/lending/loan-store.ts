import type { Loan, LoanInstallment } from '@prisma/client';
import { centsToDecimal, toCents } from '@/lib/money';
import { dateFromDay, dayFromDate } from '@/lib/business-date';
import type { TxClient } from '@/lib/db-lock';
import { delinquency, type EngineLoanStatus, type LoanState } from './engine';

export type LoanWithInstallments = Loan & { installments: LoanInstallment[] };

const ENGINE_STATUSES: EngineLoanStatus[] = ['ACTIVE', 'PAID_OFF', 'WRITTEN_OFF'];

export function isEngineManaged(status: string): status is EngineLoanStatus {
  return (ENGINE_STATUSES as string[]).includes(status);
}

/** The persisted loan as engine state. Only valid once the loan has been disbursed. */
export function stateFromRow(loan: LoanWithInstallments): LoanState {
  if (!isEngineManaged(loan.status)) {
    throw new Error(`Loan ${loan.loanNumber} has not been disbursed (status ${loan.status}).`);
  }
  if (!loan.disbursementDate || !loan.maturityDate || !loan.accruedThrough) {
    throw new Error(`Loan ${loan.loanNumber} is missing its disbursement dates.`);
  }

  return {
    status: loan.status,
    disbursementDay: dayFromDate(loan.disbursementDate),
    maturityDay: dayFromDate(loan.maturityDate),
    accruedThrough: dayFromDate(loan.accruedThrough),
    principal: toCents(loan.principalOutstanding),
    interest: toCents(loan.interestOutstanding),
    fee: toCents(loan.feeOutstanding),
    penalty: toCents(loan.penaltyOutstanding),
    tax: toCents(loan.taxOutstanding),
    credit: toCents(loan.creditBalance),
    interestAccrued: toCents(loan.interestAccrued),
    feeCharged: toCents(loan.feeCharged),
    penaltyAccrued: toCents(loan.penaltyAccrued),
    taxAccrued: toCents(loan.taxAccrued),
    principalPaid: toCents(loan.principalPaid),
    interestPaid: toCents(loan.interestPaid),
    feePaid: toCents(loan.feePaid),
    penaltyPaid: toCents(loan.penaltyPaid),
    taxPaid: toCents(loan.taxPaid),
    writtenOff: toCents(loan.writtenOff),
    maxDaysPastDue: loan.maxDaysPastDue,
    installments: [...loan.installments]
      .sort((a, b) => a.number - b.number)
      .map((i) => ({
        number: i.number,
        dueDay: dayFromDate(i.dueDate),
        principalDue: toCents(i.principalDue),
        principalPaid: toCents(i.principalPaid),
        penaltyAccrued: toCents(i.penaltyAccrued),
        penaltyPaid: toCents(i.penaltyPaid),
      })),
  };
}

/** Every balance column, from engine state. */
export function balanceColumns(state: LoanState) {
  const arrears = delinquency(state, state.accruedThrough);
  return {
    status: state.status,
    accruedThrough: dateFromDay(state.accruedThrough),
    principalOutstanding: centsToDecimal(state.principal),
    interestOutstanding: centsToDecimal(state.interest),
    feeOutstanding: centsToDecimal(state.fee),
    penaltyOutstanding: centsToDecimal(state.penalty),
    taxOutstanding: centsToDecimal(state.tax),
    creditBalance: centsToDecimal(state.credit),
    interestAccrued: centsToDecimal(state.interestAccrued),
    feeCharged: centsToDecimal(state.feeCharged),
    penaltyAccrued: centsToDecimal(state.penaltyAccrued),
    taxAccrued: centsToDecimal(state.taxAccrued),
    principalPaid: centsToDecimal(state.principalPaid),
    interestPaid: centsToDecimal(state.interestPaid),
    feePaid: centsToDecimal(state.feePaid),
    penaltyPaid: centsToDecimal(state.penaltyPaid),
    taxPaid: centsToDecimal(state.taxPaid),
    writtenOff: centsToDecimal(state.writtenOff),
    overduePrincipal: centsToDecimal(arrears.overduePrincipal),
    daysPastDue: arrears.daysPastDue,
    maxDaysPastDue: state.maxDaysPastDue,
  };
}

/** Writes the loan row and whichever installments changed. */
export async function saveState(
  tx: TxClient,
  loan: LoanWithInstallments,
  before: LoanState | null,
  after: LoanState,
  extra: Record<string, unknown> = {}
) {
  await tx.loan.update({
    where: { id: loan.id },
    data: { ...balanceColumns(after), ...extra },
  });

  const previous = new Map((before?.installments ?? []).map((i) => [i.number, i]));
  const rows = new Map(loan.installments.map((i) => [i.number, i]));

  for (const installment of after.installments) {
    const old = previous.get(installment.number);
    const changed =
      !old ||
      old.principalPaid !== installment.principalPaid ||
      old.penaltyAccrued !== installment.penaltyAccrued ||
      old.penaltyPaid !== installment.penaltyPaid;
    if (!changed) continue;

    const row = rows.get(installment.number);
    if (!row) throw new Error(`Installment ${installment.number} is missing for loan ${loan.loanNumber}.`);

    const settled =
      installment.principalPaid >= installment.principalDue &&
      installment.penaltyPaid >= installment.penaltyAccrued;

    await tx.loanInstallment.update({
      where: { id: row.id },
      data: {
        principalPaid: centsToDecimal(installment.principalPaid),
        penaltyAccrued: centsToDecimal(installment.penaltyAccrued),
        penaltyPaid: centsToDecimal(installment.penaltyPaid),
        settledAt: settled ? (row.settledAt ?? new Date()) : null,
      },
    });
  }
}
