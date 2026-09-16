import prisma from './prisma';
import { toCents, type Cents } from './money';
import { dateFromDay, dayFromDate, dayToIso, type Day } from './business-date';
import { isDebitNormal } from './accounting/chart';

/**
 * Management and accounting reports.
 *
 * Everything reads either the ledger or the loans' stored balances — nothing
 * replays loan histories. Loan balances are current to the last accrual run
 * (the nightly batch, or "Run accruals" in Accounting), which each report
 * states. The previous disbursement report derived its status from the ledger
 * alone and joined attempts on a column it never selected, so every row read
 * POSTED whatever the bank had done; here it comes from the attempt itself.
 */

const PAR_BUCKETS = [
  { key: 'current', label: 'Current', min: 0, max: 0 },
  { key: '1-30', label: '1–30 days', min: 1, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '61-90', label: '61–90 days', min: 61, max: 90 },
  { key: '91-180', label: '91–180 days', min: 91, max: 180 },
  { key: '180+', label: 'Over 180 days', min: 181, max: Number.POSITIVE_INFINITY },
] as const;

export interface PortfolioRow {
  providerId: string;
  providerName: string;
  activeLoans: number;
  principal: Cents;
  interest: Cents;
  fee: Cents;
  penalty: Cents;
  tax: Cents;
  totalOutstanding: Cents;
  overduePrincipal: Cents;
  par1: Cents;
  par30: Cents;
  par90: Cents;
  nplBorrowers: number;
  cash: Cents;
  reserved: Cents;
  accruedThrough: string | null;
}

export async function portfolioReport(providerId?: string | null): Promise<PortfolioRow[]> {
  const providers = await prisma.loanProvider.findMany({
    where: providerId ? { id: providerId } : {},
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, reservedFunds: true, nplThresholdDays: true },
  });

  const rows: PortfolioRow[] = [];
  for (const provider of providers) {
    const loans = await prisma.loan.findMany({
      where: { providerId: provider.id, status: 'ACTIVE' },
      select: {
        borrowerId: true,
        principalOutstanding: true,
        interestOutstanding: true,
        feeOutstanding: true,
        penaltyOutstanding: true,
        taxOutstanding: true,
        overduePrincipal: true,
        daysPastDue: true,
        accruedThrough: true,
      },
    });
    const cash = await prisma.ledgerAccount.findUnique({
      where: { providerId_systemKey: { providerId: provider.id, systemKey: 'CASH' } },
      select: { balance: true },
    });

    const row: PortfolioRow = {
      providerId: provider.id,
      providerName: provider.name,
      activeLoans: loans.length,
      principal: 0,
      interest: 0,
      fee: 0,
      penalty: 0,
      tax: 0,
      totalOutstanding: 0,
      overduePrincipal: 0,
      par1: 0,
      par30: 0,
      par90: 0,
      nplBorrowers: 0,
      cash: toCents(cash?.balance),
      reserved: toCents(provider.reservedFunds),
      accruedThrough: null,
    };
    const npl = new Set<string>();
    let oldest: Day | null = null;
    for (const loan of loans) {
      const principal = toCents(loan.principalOutstanding);
      row.principal += principal;
      row.interest += toCents(loan.interestOutstanding);
      row.fee += toCents(loan.feeOutstanding);
      row.penalty += toCents(loan.penaltyOutstanding);
      row.tax += toCents(loan.taxOutstanding);
      row.overduePrincipal += toCents(loan.overduePrincipal);
      if (loan.daysPastDue >= 1) row.par1 += principal;
      if (loan.daysPastDue >= 30) row.par30 += principal;
      if (loan.daysPastDue >= 90) row.par90 += principal;
      if (loan.daysPastDue >= provider.nplThresholdDays) npl.add(loan.borrowerId);
      if (loan.accruedThrough) {
        const day = dayFromDate(loan.accruedThrough);
        oldest = oldest === null ? day : Math.min(oldest, day);
      }
    }
    row.totalOutstanding = row.principal + row.interest + row.fee + row.penalty + row.tax;
    row.nplBorrowers = npl.size;
    row.accruedThrough = oldest === null ? null : dayToIso(oldest);
    rows.push(row);
  }
  return rows;
}

export interface AgingRow {
  bucket: string;
  loans: number;
  principal: Cents;
  totalOutstanding: Cents;
}

export async function agingReport(providerId?: string | null): Promise<AgingRow[]> {
  const loans = await prisma.loan.findMany({
    where: { status: 'ACTIVE', ...(providerId ? { providerId } : {}) },
    select: {
      daysPastDue: true,
      principalOutstanding: true,
      interestOutstanding: true,
      feeOutstanding: true,
      penaltyOutstanding: true,
      taxOutstanding: true,
    },
  });
  const rows = PAR_BUCKETS.map((b) => ({ bucket: b.label, loans: 0, principal: 0, totalOutstanding: 0 }));
  for (const loan of loans) {
    const index = PAR_BUCKETS.findIndex((b) => loan.daysPastDue >= b.min && loan.daysPastDue <= b.max);
    const row = rows[index === -1 ? rows.length - 1 : index];
    const principal = toCents(loan.principalOutstanding);
    row.loans += 1;
    row.principal += principal;
    row.totalOutstanding +=
      principal +
      toCents(loan.interestOutstanding) +
      toCents(loan.feeOutstanding) +
      toCents(loan.penaltyOutstanding) +
      toCents(loan.taxOutstanding);
  }
  return rows;
}

export interface CollectionsRow {
  date: string;
  receipts: number;
  amount: Cents;
  principal: Cents;
  interest: Cents;
  fee: Cents;
  penalty: Cents;
  tax: Cents;
  excess: Cents;
}

export async function collectionsReport(from: Day, to: Day, providerId?: string | null) {
  const repayments = await prisma.repayment.findMany({
    where: {
      status: 'POSTED',
      valueDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
      ...(providerId ? { loan: { providerId } } : {}),
    },
    select: {
      valueDate: true,
      channel: true,
      amount: true,
      principalPortion: true,
      interestPortion: true,
      feePortion: true,
      penaltyPortion: true,
      taxPortion: true,
      excessPortion: true,
    },
    orderBy: { valueDate: 'asc' },
  });

  const byDate = new Map<string, CollectionsRow>();
  const byChannel: Record<string, { receipts: number; amount: Cents }> = {};
  for (const r of repayments) {
    const date = dayToIso(dayFromDate(r.valueDate));
    const row =
      byDate.get(date) ??
      { date, receipts: 0, amount: 0, principal: 0, interest: 0, fee: 0, penalty: 0, tax: 0, excess: 0 };
    row.receipts += 1;
    row.amount += toCents(r.amount);
    row.principal += toCents(r.principalPortion);
    row.interest += toCents(r.interestPortion);
    row.fee += toCents(r.feePortion);
    row.penalty += toCents(r.penaltyPortion);
    row.tax += toCents(r.taxPortion);
    row.excess += toCents(r.excessPortion);
    byDate.set(date, row);
    const channel = (byChannel[r.channel] ??= { receipts: 0, amount: 0 });
    channel.receipts += 1;
    channel.amount += toCents(r.amount);
  }
  const rows = [...byDate.values()];
  const total = rows.reduce(
    (t, r) => ({
      date: 'Total',
      receipts: t.receipts + r.receipts,
      amount: t.amount + r.amount,
      principal: t.principal + r.principal,
      interest: t.interest + r.interest,
      fee: t.fee + r.fee,
      penalty: t.penalty + r.penalty,
      tax: t.tax + r.tax,
      excess: t.excess + r.excess,
    }),
    { date: 'Total', receipts: 0, amount: 0, principal: 0, interest: 0, fee: 0, penalty: 0, tax: 0, excess: 0 }
  );
  return { rows, total, byChannel };
}

export interface IncomeRow {
  providerId: string;
  providerName: string;
  interestEarned: Cents;
  feeEarned: Cents;
  penaltyEarned: Cents;
  writeOffs: Cents;
  netIncome: Cents;
  interestCollected: Cents;
  feeCollected: Cents;
  penaltyCollected: Cents;
  taxCharged: Cents;
  taxCollected: Cents;
}

/** Earned (accrual basis, from the ledger) against collected (cash basis, from receipts). */
export async function incomeReport(from: Day, to: Day, providerId?: string | null): Promise<IncomeRow[]> {
  const providers = await prisma.loanProvider.findMany({
    where: providerId ? { id: providerId } : {},
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true },
  });
  const rows: IncomeRow[] = [];
  for (const provider of providers) {
    const sums = await prisma.ledgerLine.groupBy({
      by: ['accountId'],
      where: {
        account: { providerId: provider.id },
        businessDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
      },
      _sum: { debit: true, credit: true },
    });
    const accounts = await prisma.ledgerAccount.findMany({
      where: { providerId: provider.id },
      select: { id: true, systemKey: true, type: true },
    });
    const net = (key: string) => {
      const account = accounts.find((a) => a.systemKey === key);
      const sum = account ? sums.find((s) => s.accountId === account.id)?._sum : undefined;
      if (!account || !sum) return 0;
      const debit = toCents(sum.debit);
      const credit = toCents(sum.credit);
      return isDebitNormal(account.type) ? debit - credit : credit - debit;
    };
    const taxChargedLines = await prisma.ledgerLine.aggregate({
      where: {
        account: { providerId: provider.id, systemKey: 'TAX_PAYABLE' },
        businessDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
        journal: { type: { in: ['ACCRUAL', 'DISBURSEMENT'] } },
      },
      _sum: { credit: true },
    });
    const collected = await prisma.repayment.aggregate({
      where: {
        status: 'POSTED',
        valueDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
        loan: { providerId: provider.id },
      },
      _sum: { interestPortion: true, feePortion: true, penaltyPortion: true, taxPortion: true },
    });

    const interestEarned = net('INTEREST_INCOME');
    const feeEarned = net('FEE_INCOME');
    const penaltyEarned = net('PENALTY_INCOME');
    const writeOffs = net('WRITE_OFF_EXPENSE');
    rows.push({
      providerId: provider.id,
      providerName: provider.name,
      interestEarned,
      feeEarned,
      penaltyEarned,
      writeOffs,
      netIncome: interestEarned + feeEarned + penaltyEarned - writeOffs,
      interestCollected: toCents(collected._sum.interestPortion),
      feeCollected: toCents(collected._sum.feePortion),
      penaltyCollected: toCents(collected._sum.penaltyPortion),
      taxCharged: toCents(taxChargedLines._sum.credit),
      taxCollected: toCents(collected._sum.taxPortion),
    });
  }
  return rows;
}

export async function disbursementsReport(from: Day, to: Day, providerId?: string | null) {
  const attempts = await prisma.disbursementAttempt.findMany({
    where: {
      createdAt: { gte: dateFromDay(from), lt: dateFromDay(to + 1) },
      ...(providerId ? { loan: { providerId } } : {}),
    },
    include: {
      loan: {
        select: {
          loanNumber: true,
          status: true,
          disbursementDate: true,
          provider: { select: { name: true } },
          product: { select: { name: true } },
          borrower: { select: { phoneNumber: true, fullName: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 20_000,
  });
  return attempts.map((a) => ({
    id: a.id,
    loanId: a.loanId,
    requestedAt: a.createdAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    loanNumber: a.loan.loanNumber,
    provider: a.loan.provider.name,
    product: a.loan.product.name,
    borrowerPhone: a.loan.borrower.phoneNumber,
    borrowerName: a.loan.borrower.fullName,
    account: a.creditAccount,
    amount: toCents(a.amount),
    status: a.status,
    loanStatus: a.loan.status,
    cbsReference: a.cbsReference,
    httpStatus: a.httpStatus,
    error: a.errorMessage,
  }));
}

export async function generalLedger(accountId: string, from: Day, to: Day) {
  const account = await prisma.ledgerAccount.findUnique({
    where: { id: accountId },
    include: { provider: { select: { name: true } } },
  });
  if (!account) return null;
  const opening = await prisma.ledgerLine.aggregate({
    where: { accountId, businessDate: { lt: dateFromDay(from) } },
    _sum: { debit: true, credit: true },
  });
  const debitNormal = isDebitNormal(account.type);
  const signed = (debit: Cents, credit: Cents) => (debitNormal ? debit - credit : credit - debit);
  const openingBalance = signed(toCents(opening._sum.debit), toCents(opening._sum.credit));

  const lines = await prisma.ledgerLine.findMany({
    where: { accountId, businessDate: { gte: dateFromDay(from), lte: dateFromDay(to) } },
    include: { journal: { select: { journalNo: true, type: true, description: true, createdAt: true } } },
    orderBy: [{ businessDate: 'asc' }, { journal: { createdAt: 'asc' } }],
    take: 20_000,
  });
  let running = openingBalance;
  const rows = lines.map((line) => {
    const debit = toCents(line.debit);
    const credit = toCents(line.credit);
    running += signed(debit, credit);
    return {
      date: dayToIso(dayFromDate(line.businessDate)),
      journalNo: line.journal.journalNo,
      type: line.journal.type,
      description: line.memo ? `${line.journal.description} — ${line.memo}` : line.journal.description,
      debit,
      credit,
      balance: running,
    };
  });
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type, provider: account.provider.name },
    openingBalance,
    closingBalance: running,
    rows,
  };
}
