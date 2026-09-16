import prisma from '@/lib/prisma';
import { centsToDecimal, toCents, type Cents } from '@/lib/money';
import { dateFromDay, type Day } from '@/lib/business-date';
import { nextNumber } from '@/lib/numbering';
import type { TxClient } from '@/lib/db-lock';
import type { JournalType } from '@/lib/types';
import { ApiError } from '@/lib/errors';
import { isDebitNormal, SYSTEM_ACCOUNTS, type SystemAccountKey } from './chart';

export class LedgerError extends Error {}

export interface JournalLineInput {
  account: SystemAccountKey;
  debit?: Cents;
  credit?: Cents;
  memo?: string;
}

export interface JournalInput {
  providerId: string;
  loanId?: string | null;
  businessDay: Day;
  type: JournalType;
  description: string;
  /** Same key twice posts once. Derive it from the business event, not from a random value. */
  idempotencyKey: string;
  createdById: string;
  reversalOfId?: string;
  lines: JournalLineInput[];
}

export interface NormalizedLine {
  account: SystemAccountKey;
  debit: Cents;
  credit: Cents;
  memo?: string;
}

/**
 * The rules every journal obeys, checked before anything is written: amounts
 * are whole santim, a line is a debit or a credit and never both, and the two
 * sides are equal. A journal that fails here is a bug in the caller, and the
 * transaction it is part of rolls back.
 */
export function validateJournalLines(lines: JournalLineInput[]): {
  lines: NormalizedLine[];
  total: Cents;
} {
  const normalized: NormalizedLine[] = [];
  let debits = 0;
  let credits = 0;

  for (const line of lines) {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
      throw new LedgerError(`Line on ${line.account} is not a whole number of minor units.`);
    }
    if (debit < 0 || credit < 0) {
      throw new LedgerError(`Line on ${line.account} carries a negative amount.`);
    }
    if (debit > 0 && credit > 0) {
      throw new LedgerError(`Line on ${line.account} is both a debit and a credit.`);
    }
    if (debit === 0 && credit === 0) continue;
    normalized.push({ account: line.account, debit, credit, memo: line.memo });
    debits += debit;
    credits += credit;
  }

  if (normalized.length < 2) {
    throw new LedgerError('A journal needs at least one debit and one credit.');
  }
  if (debits !== credits) {
    throw new LedgerError(`Journal does not balance: debits ${debits} ≠ credits ${credits}.`);
  }
  return { lines: normalized, total: debits };
}

/** Creates any system account a provider's book is missing. Idempotent. */
export async function provisionChartOfAccounts(client: TxClient, providerId: string) {
  const existing = await client.ledgerAccount.findMany({
    where: { providerId },
    select: { systemKey: true },
  });
  const have = new Set(existing.map((a) => a.systemKey));
  const missing = SYSTEM_ACCOUNTS.filter((a) => !have.has(a.key));
  if (missing.length === 0) return 0;
  await client.ledgerAccount.createMany({
    data: missing.map((a) => ({
      providerId,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.key,
    })),
  });
  return missing.length;
}

export interface PostedJournal {
  id: string;
  journalNo: string;
  duplicate: boolean;
}

/**
 * Posts a balanced journal and moves the cached account balances with it, in
 * the caller's transaction. Journals are immutable: a mistake is corrected by
 * posting its reversal, never by editing or deleting lines.
 */
export async function postJournal(tx: TxClient, input: JournalInput): Promise<PostedJournal> {
  const { lines, total } = validateJournalLines(input.lines);

  const existing = await tx.journalEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, journalNo: true, providerId: true, totalAmount: true },
  });
  if (existing) {
    if (existing.providerId !== input.providerId || toCents(existing.totalAmount) !== total) {
      // Same business reference, different money: a conflict for the caller to
      // resolve, never something to post over.
      throw new ApiError(409, 'That reference has already been used for a different posting.');
    }
    return { id: existing.id, journalNo: existing.journalNo, duplicate: true };
  }

  const keys = [...new Set(lines.map((l) => l.account))];
  const accounts = await tx.ledgerAccount.findMany({
    where: { providerId: input.providerId, systemKey: { in: keys } },
    select: { id: true, systemKey: true, type: true, isActive: true },
  });
  const byKey = new Map(accounts.map((a) => [a.systemKey, a]));
  for (const key of keys) {
    const account = byKey.get(key);
    if (!account) throw new LedgerError(`Provider ${input.providerId} has no ${key} account.`);
    if (!account.isActive) throw new LedgerError(`Account ${key} is inactive and cannot be posted to.`);
  }

  const journalNo = await nextNumber(tx, 'journal');
  const businessDate = dateFromDay(input.businessDay);

  const journal = await tx.journalEntry.create({
    data: {
      journalNo,
      providerId: input.providerId,
      loanId: input.loanId ?? null,
      businessDate,
      type: input.type,
      description: input.description.slice(0, 500),
      idempotencyKey: input.idempotencyKey,
      totalAmount: centsToDecimal(total),
      reversalOfId: input.reversalOfId ?? null,
      createdById: input.createdById,
    },
    select: { id: true },
  });

  await tx.ledgerLine.createMany({
    data: lines.map((line) => ({
      journalId: journal.id,
      accountId: byKey.get(line.account)!.id,
      debit: centsToDecimal(line.debit),
      credit: centsToDecimal(line.credit),
      businessDate,
      loanId: input.loanId ?? null,
      memo: line.memo?.slice(0, 200),
    })),
  });

  const net = new Map<string, Cents>();
  for (const line of lines) {
    const account = byKey.get(line.account)!;
    const signed = isDebitNormal(account.type) ? line.debit - line.credit : line.credit - line.debit;
    net.set(account.id, (net.get(account.id) ?? 0) + signed);
  }
  for (const [accountId, amount] of net) {
    if (amount === 0) continue;
    await tx.ledgerAccount.update({
      where: { id: accountId },
      data: { balance: { increment: centsToDecimal(amount) } },
    });
  }

  return { id: journal.id, journalNo, duplicate: false };
}

/** Posts the mirror image of a journal. */
export async function reverseJournal(
  tx: TxClient,
  journalId: string,
  input: { businessDay: Day; description: string; createdById: string; idempotencyKey?: string }
): Promise<PostedJournal> {
  const original = await tx.journalEntry.findUnique({
    where: { id: journalId },
    include: { lines: { include: { account: { select: { systemKey: true } } } } },
  });
  if (!original) throw new LedgerError('Journal to reverse was not found.');

  return postJournal(tx, {
    providerId: original.providerId,
    loanId: original.loanId,
    businessDay: input.businessDay,
    type: 'REVERSAL',
    description: input.description,
    idempotencyKey: input.idempotencyKey ?? `REVERSAL:${original.id}`,
    createdById: input.createdById,
    reversalOfId: original.id,
    lines: original.lines.map((line) => ({
      account: line.account.systemKey as SystemAccountKey,
      debit: toCents(line.credit),
      credit: toCents(line.debit),
      memo: line.memo ?? undefined,
    })),
  });
}

// ----------------------------------------
// Verification
// ----------------------------------------

export interface LedgerCheck {
  providerId: string;
  providerName: string;
  check: string;
  expected: Cents;
  actual: Cents;
  ok: boolean;
}

/**
 * Proves the books are sound, provider by provider:
 *
 *  1. total debits equal total credits;
 *  2. every cached account balance equals the sum of its own lines;
 *  3. every control account equals the loan sub-ledger it summarises —
 *     principal, interest, fee, penalty and tax receivable against the loans'
 *     outstanding balances, and overpayments against their credit balances.
 *
 * Any row with `ok: false` is a defect, not a rounding difference: nothing in
 * this system rounds after posting.
 */
export async function verifyLedger(providerId?: string): Promise<LedgerCheck[]> {
  const providers = await prisma.loanProvider.findMany({
    where: providerId ? { id: providerId } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const results: LedgerCheck[] = [];

  for (const provider of providers) {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { providerId: provider.id },
      select: { id: true, systemKey: true, name: true, type: true, balance: true },
    });
    const sums = await prisma.ledgerLine.groupBy({
      by: ['accountId'],
      where: { account: { providerId: provider.id } },
      _sum: { debit: true, credit: true },
    });
    const sumByAccount = new Map(
      sums.map((s) => [s.accountId, { debit: toCents(s._sum.debit), credit: toCents(s._sum.credit) }])
    );

    let totalDebit = 0;
    let totalCredit = 0;
    const balanceByKey = new Map<string, Cents>();

    for (const account of accounts) {
      const sum = sumByAccount.get(account.id) ?? { debit: 0, credit: 0 };
      totalDebit += sum.debit;
      totalCredit += sum.credit;
      const fromLines = isDebitNormal(account.type) ? sum.debit - sum.credit : sum.credit - sum.debit;
      const cached = toCents(account.balance);
      balanceByKey.set(account.systemKey, fromLines);
      results.push({
        providerId: provider.id,
        providerName: provider.name,
        check: `Balance of ${account.name} matches its lines`,
        expected: fromLines,
        actual: cached,
        ok: fromLines === cached,
      });
    }

    results.unshift({
      providerId: provider.id,
      providerName: provider.name,
      check: 'Total debits equal total credits',
      expected: totalDebit,
      actual: totalCredit,
      ok: totalDebit === totalCredit,
    });

    const loans = await prisma.loan.aggregate({
      where: { providerId: provider.id, status: { in: ['ACTIVE', 'PAID_OFF', 'WRITTEN_OFF'] } },
      _sum: {
        principalOutstanding: true,
        interestOutstanding: true,
        feeOutstanding: true,
        penaltyOutstanding: true,
        taxOutstanding: true,
        creditBalance: true,
      },
    });

    const subledger: Array<[SystemAccountKey, string, Cents]> = [
      ['LOANS_RECEIVABLE', 'Loans receivable equals outstanding principal', toCents(loans._sum.principalOutstanding)],
      ['INTEREST_RECEIVABLE', 'Interest receivable equals outstanding interest', toCents(loans._sum.interestOutstanding)],
      ['FEE_RECEIVABLE', 'Fee receivable equals outstanding fees', toCents(loans._sum.feeOutstanding)],
      ['PENALTY_RECEIVABLE', 'Penalty receivable equals outstanding penalties', toCents(loans._sum.penaltyOutstanding)],
      ['TAX_RECEIVABLE', 'Tax receivable equals outstanding tax', toCents(loans._sum.taxOutstanding)],
      ['BORROWER_CREDITS', 'Overpayments equal borrower credit balances', toCents(loans._sum.creditBalance)],
    ];
    for (const [key, check, expected] of subledger) {
      const actual = balanceByKey.get(key) ?? 0;
      results.push({
        providerId: provider.id,
        providerName: provider.name,
        check,
        expected,
        actual,
        ok: expected === actual,
      });
    }
  }

  return results;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: Cents;
  credit: Cents;
}

/** Account balances as of the end of `asOfDay`, laid out as debit and credit columns. */
export async function trialBalance(providerId: string, asOfDay: Day): Promise<TrialBalanceRow[]> {
  const accounts = await prisma.ledgerAccount.findMany({
    where: { providerId },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, type: true },
  });
  const sums = await prisma.ledgerLine.groupBy({
    by: ['accountId'],
    where: { account: { providerId }, businessDate: { lte: dateFromDay(asOfDay) } },
    _sum: { debit: true, credit: true },
  });
  const byAccount = new Map(sums.map((s) => [s.accountId, s._sum]));

  return accounts.map((account) => {
    const sum = byAccount.get(account.id);
    const net = toCents(sum?.debit) - toCents(sum?.credit);
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    };
  });
}
