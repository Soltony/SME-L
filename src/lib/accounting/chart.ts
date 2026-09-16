import type { AccountType } from '@/lib/types';

/**
 * The chart of accounts every provider's book starts with.
 *
 * Accrual accounting, and every entry balanced:
 *
 *   Capital injected      Dr Loan fund               Cr Provider capital
 *   Loan disbursed        Dr Loans receivable        Cr Loan fund
 *   Service fee charged   Dr Fee receivable          Cr Fee income
 *   Interest accrued      Dr Interest receivable     Cr Interest income
 *   Penalty accrued       Dr Penalty receivable      Cr Penalty income
 *   Tax charged           Dr Tax receivable          Cr Tax payable
 *   Repayment received    Dr Loan fund               Cr each receivable it settles
 *                                                    Cr Borrower overpayments (any excess)
 *   Overpayment refunded  Dr Borrower overpayments   Cr Loan fund
 *   Tax remitted          Dr Tax payable             Cr Loan fund
 *   Loan written off      Dr Write-off expense       Cr Loans receivable
 *                         Dr each income account     Cr its receivable (unpaid accruals reversed)
 *                         Dr Tax payable             Cr Tax receivable
 *
 * The previous system posted a debit to "Interest Receivable" every night with
 * no credit at all, credited income twice on every repayment (receivable *and*
 * income against a single debit), and never booked the cash side of a
 * disbursement, so its trial balance could not balance by construction.
 */

export const SYSTEM_ACCOUNTS = [
  { key: 'CASH', code: '1000', name: 'Loan fund (cash)', type: 'ASSET' },
  { key: 'LOANS_RECEIVABLE', code: '1100', name: 'Loans receivable — principal', type: 'ASSET' },
  { key: 'INTEREST_RECEIVABLE', code: '1110', name: 'Interest receivable', type: 'ASSET' },
  { key: 'FEE_RECEIVABLE', code: '1120', name: 'Service fee receivable', type: 'ASSET' },
  { key: 'PENALTY_RECEIVABLE', code: '1130', name: 'Penalty receivable', type: 'ASSET' },
  { key: 'TAX_RECEIVABLE', code: '1140', name: 'Tax receivable from borrowers', type: 'ASSET' },
  { key: 'TAX_PAYABLE', code: '2100', name: 'Tax payable', type: 'LIABILITY' },
  { key: 'BORROWER_CREDITS', code: '2200', name: 'Borrower overpayments', type: 'LIABILITY' },
  { key: 'CAPITAL', code: '3000', name: 'Provider capital', type: 'EQUITY' },
  { key: 'INTEREST_INCOME', code: '4000', name: 'Interest income', type: 'INCOME' },
  { key: 'FEE_INCOME', code: '4100', name: 'Service fee income', type: 'INCOME' },
  { key: 'PENALTY_INCOME', code: '4200', name: 'Penalty income', type: 'INCOME' },
  { key: 'WRITE_OFF_EXPENSE', code: '5000', name: 'Loan write-off expense', type: 'EXPENSE' },
] as const satisfies ReadonlyArray<{ key: string; code: string; name: string; type: AccountType }>;

export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[number]['key'];

/** Assets and expenses grow with debits; the rest grow with credits. */
export function isDebitNormal(type: string): boolean {
  return type === 'ASSET' || type === 'EXPENSE';
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
};
