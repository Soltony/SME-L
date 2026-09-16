import prisma from '@/lib/prisma';
import type { TxClient } from '@/lib/db-lock';
import { dayToIso, today } from '@/lib/business-date';
import {
  fetchAccountStatement,
  fetchCustomerInfo,
  type CbsCustomerInfo,
  type CbsStatementLine,
} from '@/lib/integrations/core-banking';
import { CORE_BANKING_FIELD_KEYS } from './scoring-fields';
import { normalizeFieldName } from './scoring';

/**
 * A borrower's core-banking figures for scoring.
 *
 * Fetched per verified account — the customer record and six months of
 * statement — and reduced straight away to the handful of numbers in
 * `CORE_BANKING_FIELDS`. Kept for a day, so a borrower browsing products does
 * not send the bank a statement request per tap.
 *
 * Never fetched inside a transaction: eligibility is re-checked under the
 * borrower lock, and a slow bank must not hold that lock. Callers refresh
 * first with `refreshCoreBankingProfile`, and scoring reads what is stored.
 */

export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a failed attempt, wait this long before asking the bank again. */
export const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
export const STATEMENT_MONTHS = 6;

export type CoreBankingValues = Record<string, number | string>;

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** YYYY-MM keys of the `count` calendar months ending with the month of `endIso`, oldest first. */
export function monthWindow(endIso: string, count = STATEMENT_MONTHS): string[] {
  const [y, m] = endIso.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return date.toISOString().slice(0, 7);
  });
}

/** The first day of the statement window, for the request to the bank. */
export function windowStart(endIso: string, count = STATEMENT_MONTHS): Date {
  return new Date(`${monthWindow(endIso, count)[0]}-01T00:00:00Z`);
}

/**
 * Six months of statements, across all the borrower's accounts, as scoring figures.
 *
 * Money in and out are summed across accounts per month and the median month
 * is taken. Balances are per account at each month end — carried forward from
 * the last line seen — then added up across accounts.
 */
export function summarizeStatements(accounts: CbsStatementLine[][], endIso: string): CoreBankingValues {
  const months = monthWindow(endIso);
  const deposits = new Map(months.map((m) => [m, 0]));
  const withdrawals = new Map(months.map((m) => [m, 0]));
  const balances = new Map<string, number>();
  const sources = new Set<string>();
  let depositCount = 0;

  for (const lines of accounts) {
    const inWindow = lines.filter((l) => l.date && deposits.has(l.date.slice(0, 7))).sort((a, b) => a.date!.localeCompare(b.date!));
    for (const line of inWindow) {
      const month = line.date!.slice(0, 7);
      if (line.credit > 0) {
        deposits.set(month, deposits.get(month)! + line.credit);
        depositCount += 1;
        if (line.counterparty) sources.add(line.counterparty.toLowerCase());
      }
      if (line.debit > 0) withdrawals.set(month, withdrawals.get(month)! + line.debit);
    }
    let carried: number | null = null;
    for (const month of months) {
      const last = inWindow.filter((l) => l.date!.startsWith(month) && l.balance !== null).pop();
      if (last) carried = last.balance;
      if (carried !== null) balances.set(month, (balances.get(month) ?? 0) + carried);
    }
  }

  const totalIn = [...deposits.values()].reduce((a, b) => a + b, 0);
  const totalOut = [...withdrawals.values()].reduce((a, b) => a + b, 0);
  const monthEnd = [...balances.values()];
  const values: CoreBankingValues = {
    avgMonthlyDeposit: round2(median([...deposits.values()])),
    avgMonthlyWithdrawal: round2(median([...withdrawals.values()])),
    activeMonths: [...deposits.values()].filter((v) => v > 0).length,
    depositCount,
    depositSources: sources.size,
  };
  if (monthEnd.length) {
    values.avgBalance = round2(monthEnd.reduce((a, b) => a + b, 0) / monthEnd.length);
    values.lowestBalance = round2(Math.min(...monthEnd));
  }
  if (totalIn > 0) values.withdrawalToDepositPercent = Math.round((totalOut / totalIn) * 100);
  return values;
}

function wholeYearsBetween(fromIso: string, toIso: string) {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

function wholeMonthsBetween(fromIso: string, toIso: string) {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/** The customer record as scoring figures. The same customer across accounts; the oldest account sets time with the bank. */
export function summarizeCustomer(infos: CbsCustomerInfo[], todayIso: string): CoreBankingValues {
  const first = <K extends keyof CbsCustomerInfo>(key: K) => infos.map((i) => i[key]).find((v) => v !== null && v !== undefined) ?? null;
  const values: CoreBankingValues = {};
  const income = first('netMonthlyIncome');
  if (typeof income === 'number') values.netMonthlyIncome = round2(income);
  const born = first('dateOfBirth');
  if (typeof born === 'string' && born <= todayIso) values.ageYears = wholeYearsBetween(born, todayIso);
  const opened = infos.map((i) => i.accountOpeningDate).filter((d): d is string => Boolean(d) && d! <= todayIso).sort()[0];
  if (opened) values.accountAgeMonths = wholeMonthsBetween(opened, todayIso);
  for (const key of ['occupation', 'region', 'city'] as const) {
    const text = first(key);
    if (typeof text === 'string') values[key] = text;
  }
  return values;
}

/** Whether a stored profile is recent and complete enough not to ask the bank again. */
export function profileIsCurrent(
  profile: { fetchedAt: Date | null; attemptedAt: Date; lastError: string | null } | null,
  now: Date
): boolean {
  if (!profile) return false;
  if (profile.lastError) return now.getTime() - profile.attemptedAt.getTime() < RETRY_AFTER_FAILURE_MS;
  return profile.fetchedAt !== null && now.getTime() - profile.fetchedAt.getTime() < PROFILE_MAX_AGE_MS;
}

/**
 * Brings a borrower's figures up to date if they are more than a day old.
 *
 * A bank that cannot be reached leaves the last good figures in place and is
 * asked again after ten minutes. Accounts that could not be read are recorded
 * in `lastError`, and the partial figures are kept only if there were none before.
 */
export async function refreshCoreBankingProfile(borrowerId: string, now = new Date()): Promise<void> {
  const existing = await prisma.borrowerCoreBankingProfile.findUnique({ where: { borrowerId } });
  if (profileIsCurrent(existing, now)) return;

  const accounts = await prisma.borrowerAccount.findMany({ where: { borrowerId }, select: { accountNumber: true } });
  const todayIso = dayToIso(today(now));
  const results = await Promise.allSettled(
    accounts.map(async ({ accountNumber }) => {
      const [info, statement] = await Promise.all([
        fetchCustomerInfo(accountNumber),
        fetchAccountStatement(accountNumber, windowStart(todayIso), now),
      ]);
      return { info, statement };
    })
  );
  const read = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failures = results.length - read.length;
  if (failures) {
    const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
    console.error(`[core-banking] ${failures} of ${results.length} account(s) could not be read for scoring`, reason);
  }

  const lastError =
    accounts.length === 0
      ? 'The borrower has no verified accounts.'
      : failures
        ? `${failures} of ${accounts.length} account(s) could not be read from core banking.`
        : null;
  const keepOld = Boolean(lastError && existing?.fetchedAt);
  const values = keepOld || read.length === 0
    ? null
    : { ...summarizeCustomer(read.map((r) => r.info), todayIso), ...summarizeStatements(read.map((r) => r.statement), todayIso) };

  await prisma.borrowerCoreBankingProfile.upsert({
    where: { borrowerId },
    create: {
      borrowerId,
      values: JSON.stringify(values ?? {}),
      accountCount: read.length,
      fetchedAt: values && !lastError ? now : null,
      attemptedAt: now,
      lastError,
    },
    update: {
      ...(values ? { values: JSON.stringify(values), accountCount: read.length } : {}),
      ...(values && !lastError ? { fetchedAt: now } : {}),
      attemptedAt: now,
      lastError,
    },
  });
}

/** The stored figures, or null when core banking has never answered for this borrower. */
export async function readCoreBankingValues(client: TxClient, borrowerId: string): Promise<CoreBankingValues | null> {
  const profile = await client.borrowerCoreBankingProfile.findUnique({ where: { borrowerId }, select: { values: true } });
  if (!profile) return null;
  try {
    const values = JSON.parse(profile.values) as CoreBankingValues;
    return Object.keys(values).length ? values : null;
  } catch {
    return null;
  }
}

/** Whether a provider's scoring model uses any core-banking field. */
export async function providerScoresOnCoreBanking(client: TxClient, providerId: string): Promise<boolean> {
  const rules = await client.scoringRule.findMany({ where: { parameter: { providerId } }, select: { field: true } });
  return rules.some((r) => CORE_BANKING_FIELD_KEYS.has(normalizeFieldName(r.field)));
}

/**
 * Refreshes a borrower's figures if the product about to be evaluated needs them.
 * Call before `evaluateEligibility`, and never inside a transaction.
 */
export async function prepareCoreBankingForProduct(borrowerId: string, productId: string): Promise<void> {
  const product = await prisma.loanProduct.findUnique({ where: { id: productId }, select: { providerId: true, requiresScoring: true } });
  if (!product?.requiresScoring || !(await providerScoresOnCoreBanking(prisma, product.providerId))) return;
  try {
    await refreshCoreBankingProfile(borrowerId);
  } catch (error) {
    // Eligibility then decides what to do without fresh figures.
    console.error('[core-banking] profile refresh failed', error);
  }
}
