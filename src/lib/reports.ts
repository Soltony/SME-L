import type { Prisma } from '@prisma/client';
import prisma from './prisma';
import { toCents, type Cents } from './money';
import { dateFromDay, dayFromDate, dayToIso, type Day } from './business-date';
import { isDebitNormal } from './accounting/chart';
import { normalizePhone } from './format';
import { parseTerms } from './lending/terms';
import {
  classifyNbe,
  describeInterest,
  describeServiceFee,
  NBE_CLASSES,
  nbeLabel,
  NON_PERFORMING_CLASSES,
  repaymentFrequency,
  splitFullName,
  trendGranularity,
  trendKey,
  trendKeys,
  type NbeClass,
  type TrendGranularity,
} from './report-helpers';

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

/** SQL Server refuses a statement with more than ~2100 parameters, so long `IN` lists are split. */
const IN_CHUNK = 1000;

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function outstandingOf(loan: {
  principalOutstanding: Prisma.Decimal;
  interestOutstanding: Prisma.Decimal;
  feeOutstanding: Prisma.Decimal;
  penaltyOutstanding: Prisma.Decimal;
  taxOutstanding: Prisma.Decimal;
}): Cents {
  return (
    toCents(loan.principalOutstanding) +
    toCents(loan.interestOutstanding) +
    toCents(loan.feeOutstanding) +
    toCents(loan.penaltyOutstanding) +
    toCents(loan.taxOutstanding)
  );
}

// ----------------------------------------
// Overview
// ----------------------------------------

export interface TrendPoint {
  period: string;
  disbursed: Cents;
  collected: Cents;
}

export interface OverviewReport {
  disbursed: { amount: Cents; loans: number; borrowers: number };
  collected: {
    amount: Cents;
    receipts: number;
    principal: Cents;
    interest: Cents;
    fee: Cents;
    penalty: Cents;
    tax: Cents;
    excess: Cents;
  };
  granularity: TrendGranularity;
  trend: TrendPoint[];
}

/**
 * What moved in the period: money lent and money received, with a trend. The
 * book as it stands today comes from `portfolioReport` and `classificationReport`.
 */
export async function overviewReport(from: Day, to: Day, providerId?: string | null): Promise<OverviewReport> {
  const period = { gte: dateFromDay(from), lte: dateFromDay(to) };
  const loanWhere: Prisma.LoanWhereInput = { disbursementDate: period, ...(providerId ? { providerId } : {}) };
  const receiptWhere: Prisma.RepaymentWhereInput = {
    status: 'POSTED',
    valueDate: period,
    ...(providerId ? { loan: { providerId } } : {}),
  };

  const [disbursed, borrowers, collected, disbursedByDay, collectedByDay] = await Promise.all([
    prisma.loan.aggregate({ where: loanWhere, _sum: { principalAmount: true }, _count: { _all: true } }),
    prisma.loan.groupBy({ by: ['borrowerId'], where: loanWhere }),
    prisma.repayment.aggregate({
      where: receiptWhere,
      _sum: {
        amount: true,
        principalPortion: true,
        interestPortion: true,
        feePortion: true,
        penaltyPortion: true,
        taxPortion: true,
        excessPortion: true,
      },
      _count: { _all: true },
    }),
    prisma.loan.groupBy({ by: ['disbursementDate'], where: loanWhere, _sum: { principalAmount: true } }),
    prisma.repayment.groupBy({ by: ['valueDate'], where: receiptWhere, _sum: { amount: true } }),
  ]);

  const granularity = trendGranularity(from, to);
  const series = new Map(trendKeys(from, to, granularity).map((period) => [period, { period, disbursed: 0, collected: 0 }]));
  for (const row of disbursedByDay) {
    if (!row.disbursementDate) continue;
    const point = series.get(trendKey(dayFromDate(row.disbursementDate), granularity));
    if (point) point.disbursed += toCents(row._sum.principalAmount);
  }
  for (const row of collectedByDay) {
    const point = series.get(trendKey(dayFromDate(row.valueDate), granularity));
    if (point) point.collected += toCents(row._sum.amount);
  }

  return {
    disbursed: {
      amount: toCents(disbursed._sum.principalAmount),
      loans: disbursed._count._all,
      borrowers: borrowers.length,
    },
    collected: {
      amount: toCents(collected._sum.amount),
      receipts: collected._count._all,
      principal: toCents(collected._sum.principalPortion),
      interest: toCents(collected._sum.interestPortion),
      fee: toCents(collected._sum.feePortion),
      penalty: toCents(collected._sum.penaltyPortion),
      tax: toCents(collected._sum.taxPortion),
      excess: toCents(collected._sum.excessPortion),
    },
    granularity,
    trend: [...series.values()],
  };
}

// ----------------------------------------
// NBE asset classification
// ----------------------------------------

export interface ClassificationCell {
  loans: number;
  principal: Cents;
  outstanding: Cents;
}

export interface ClassificationRow {
  providerId: string;
  providerName: string;
  classes: Record<NbeClass, ClassificationCell>;
  total: ClassificationCell;
}

const emptyCell = (): ClassificationCell => ({ loans: 0, principal: 0, outstanding: 0 });

function emptyClasses(): Record<NbeClass, ClassificationCell> {
  return Object.fromEntries(NBE_CLASSES.map((c) => [c.key, emptyCell()])) as Record<NbeClass, ClassificationCell>;
}

/** Every active loan classified by its days past due, per provider. */
export async function classificationReport(providerId?: string | null): Promise<ClassificationRow[]> {
  const [providers, loans] = await Promise.all([
    prisma.loanProvider.findMany({
      where: providerId ? { id: providerId } : {},
      orderBy: { displayOrder: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.loan.findMany({
      where: { status: 'ACTIVE', ...(providerId ? { providerId } : {}) },
      select: {
        providerId: true,
        daysPastDue: true,
        principalOutstanding: true,
        interestOutstanding: true,
        feeOutstanding: true,
        penaltyOutstanding: true,
        taxOutstanding: true,
      },
    }),
  ]);

  const rows = new Map<string, ClassificationRow>(
    providers.map((p) => [p.id, { providerId: p.id, providerName: p.name, classes: emptyClasses(), total: emptyCell() }])
  );
  for (const loan of loans) {
    const row = rows.get(loan.providerId);
    if (!row) continue;
    const principal = toCents(loan.principalOutstanding);
    const outstanding = outstandingOf(loan);
    for (const cell of [row.classes[classifyNbe(loan.daysPastDue)], row.total]) {
      cell.loans += 1;
      cell.principal += principal;
      cell.outstanding += outstanding;
    }
  }
  return [...rows.values()];
}

/** The per-provider classification added across providers. */
export function sumClassification(rows: ClassificationRow[]): Omit<ClassificationRow, 'providerId' | 'providerName'> {
  const classes = emptyClasses();
  const total = emptyCell();
  for (const row of rows) {
    for (const c of NBE_CLASSES) {
      classes[c.key].loans += row.classes[c.key].loans;
      classes[c.key].principal += row.classes[c.key].principal;
      classes[c.key].outstanding += row.classes[c.key].outstanding;
    }
    total.loans += row.total.loans;
    total.principal += row.total.principal;
    total.outstanding += row.total.outstanding;
  }
  return { classes, total };
}

/** Principal in the non-performing classes, for the NPL ratio. */
export function nplPrincipal(row: Pick<ClassificationRow, 'classes'>): Cents {
  return NON_PERFORMING_CLASSES.reduce((sum, key) => sum + row.classes[key].principal, 0);
}

// ----------------------------------------
// Borrower-level aging
// ----------------------------------------

export interface BorrowerAgingRow {
  borrowerId: string;
  borrowerName: string | null;
  phoneNumber: string;
  providers: string[];
  loanNumbers: string[];
  /** The loan in the worst arrears, for the link. */
  worstLoanId: string;
  accounts: string[];
  daysPastDue: number;
  classification: NbeClass;
  principal: Cents;
  interest: Cents;
  fee: Cents;
  penalty: Cents;
  tax: Cents;
  overduePrincipal: Cents;
  totalOutstanding: Cents;
}

/**
 * Each borrower's active loans added together and classified by the worst of
 * them — a borrower is only as current as their most overdue loan. With no
 * class chosen, only borrowers with something past due are listed.
 */
export async function borrowerAgingReport(
  providerId: string | null | undefined,
  filter: { classification?: NbeClass | null; q?: string | null } = {}
): Promise<BorrowerAgingRow[]> {
  const loans = await prisma.loan.findMany({
    where: { status: 'ACTIVE', ...(providerId ? { providerId } : {}) },
    select: {
      id: true,
      loanNumber: true,
      borrowerId: true,
      disbursementAccount: true,
      daysPastDue: true,
      principalOutstanding: true,
      interestOutstanding: true,
      feeOutstanding: true,
      penaltyOutstanding: true,
      taxOutstanding: true,
      overduePrincipal: true,
      provider: { select: { name: true } },
      borrower: { select: { fullName: true, phoneNumber: true } },
    },
  });

  const byBorrower = new Map<string, BorrowerAgingRow>();
  for (const loan of loans) {
    let row = byBorrower.get(loan.borrowerId);
    if (!row) {
      row = {
        borrowerId: loan.borrowerId,
        borrowerName: loan.borrower.fullName,
        phoneNumber: loan.borrower.phoneNumber,
        providers: [],
        loanNumbers: [],
        worstLoanId: loan.id,
        accounts: [],
        daysPastDue: loan.daysPastDue,
        classification: 'PASS',
        principal: 0,
        interest: 0,
        fee: 0,
        penalty: 0,
        tax: 0,
        overduePrincipal: 0,
        totalOutstanding: 0,
      };
      byBorrower.set(loan.borrowerId, row);
    }
    if (!row.providers.includes(loan.provider.name)) row.providers.push(loan.provider.name);
    if (!row.accounts.includes(loan.disbursementAccount)) row.accounts.push(loan.disbursementAccount);
    row.loanNumbers.push(loan.loanNumber);
    if (loan.daysPastDue > row.daysPastDue) {
      row.daysPastDue = loan.daysPastDue;
      row.worstLoanId = loan.id;
    }
    row.principal += toCents(loan.principalOutstanding);
    row.interest += toCents(loan.interestOutstanding);
    row.fee += toCents(loan.feeOutstanding);
    row.penalty += toCents(loan.penaltyOutstanding);
    row.tax += toCents(loan.taxOutstanding);
    row.overduePrincipal += toCents(loan.overduePrincipal);
    row.totalOutstanding += outstandingOf(loan);
  }

  const q = filter.q?.trim().toLowerCase() ?? '';
  const phone = q ? normalizePhone(q) : '';
  const rows: BorrowerAgingRow[] = [];
  for (const row of byBorrower.values()) {
    row.classification = classifyNbe(row.daysPastDue);
    if (filter.classification ? row.classification !== filter.classification : row.daysPastDue < 1) continue;
    if (
      q &&
      !(row.borrowerName ?? '').toLowerCase().includes(q) &&
      !(phone && row.phoneNumber.includes(phone)) &&
      !row.loanNumbers.some((n) => n.toLowerCase().includes(q)) &&
      !row.accounts.some((a) => a.includes(q))
    ) {
      continue;
    }
    rows.push(row);
  }
  return rows.sort((a, b) => b.daysPastDue - a.daysPastDue || b.totalOutstanding - a.totalOutstanding);
}

// ----------------------------------------
// Fund utilization
// ----------------------------------------

export interface FundUtilizationRow {
  providerId: string;
  providerName: string;
  capital: Cents;
  cash: Cents;
  reserved: Cents;
  available: Cents;
  principalOutstanding: Cents;
  /** Principal lent out or committed, over everything the fund could lend; null for an empty fund. */
  utilization: number | null;
  disbursed: Cents;
  principalRecovered: Cents;
}

/**
 * How much of each provider's fund is at work. Cash still holds loans awaiting
 * disbursement (they leave it when the bank confirms), so those count as
 * committed rather than available.
 */
export async function fundUtilizationReport(from: Day, to: Day, providerId?: string | null): Promise<FundUtilizationRow[]> {
  const period = { gte: dateFromDay(from), lte: dateFromDay(to) };
  const portfolio = await portfolioReport(providerId);
  const ids = portfolio.map((p) => p.providerId);
  const [capital, disbursed, recovered] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { systemKey: 'CAPITAL', providerId: { in: ids } },
      select: { providerId: true, balance: true },
    }),
    prisma.loan.groupBy({
      by: ['providerId'],
      where: { providerId: { in: ids }, disbursementDate: period },
      _sum: { principalAmount: true },
    }),
    Promise.all(
      ids.map((id) =>
        prisma.repayment.aggregate({
          where: { status: 'POSTED', valueDate: period, loan: { providerId: id } },
          _sum: { principalPortion: true },
        })
      )
    ),
  ]);

  return portfolio.map((p, index) => {
    const committed = p.principal + p.reserved;
    const pool = p.principal + p.cash;
    return {
      providerId: p.providerId,
      providerName: p.providerName,
      capital: toCents(capital.find((c) => c.providerId === p.providerId)?.balance),
      cash: p.cash,
      reserved: p.reserved,
      available: p.cash - p.reserved,
      principalOutstanding: p.principal,
      utilization: pool > 0 ? committed / pool : null,
      disbursed: toCents(disbursed.find((d) => d.providerId === p.providerId)?._sum.principalAmount),
      principalRecovered: toCents(recovered[index]._sum.principalPortion),
    };
  });
}

// ----------------------------------------
// Regulatory loan register (National Bank)
// ----------------------------------------

export interface RegulatoryRow {
  loanId: string;
  loanNumber: string;
  status: string;
  provider: string;
  product: string;
  firstName: string;
  middleName: string;
  lastName: string;
  phoneNumber: string;
  account: string;
  region: string;
  city: string;
  occupation: string;
  monthlyIncome: number | null;
  /** Approved typed documents (TIN, ID numbers), by document type id. */
  documents: Record<string, string>;
  applicationAmount: Cents;
  approvedAmount: Cents;
  disbursementDate: string;
  maturityDate: string | null;
  durationDays: number | null;
  repaymentFrequency: string;
  interestRate: string;
  serviceCharge: string;
  outstanding: Cents;
  daysPastDue: number;
  classification: string;
  settlementDate: string | null;
  loanCycle: number;
  creditScore: number | null;
}

export interface RegulatoryReport {
  /** The bank's typed documents, which become the register's identifier columns. */
  documentTypes: { id: string; name: string }[];
  rows: RegulatoryRow[];
  total: number;
}

function profileValues(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function regulatoryWhere(from: Day, to: Day, providerId?: string | null, q?: string | null): Prisma.LoanWhereInput {
  const where: Prisma.LoanWhereInput = {
    disbursementDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
    ...(providerId ? { providerId } : {}),
  };
  const search = q?.trim();
  if (search) {
    where.OR = [
      { loanNumber: { contains: search } },
      { disbursementAccount: { contains: search } },
      { borrower: { phoneNumber: { contains: normalizePhone(search) || search } } },
      { borrower: { fullName: { contains: search } } },
    ];
  }
  return where;
}

/**
 * Every loan disbursed in the period, one row each, in the shape the National
 * Bank's credit register asks for. Identity comes from what the bank already
 * holds: the name and verified account, the core-banking profile (region, city,
 * occupation, income) and the approved typed documents. The platform does not
 * keep gender or date of birth, so the register does not carry them.
 */
export async function regulatoryReport(
  from: Day,
  to: Day,
  providerId: string | null | undefined,
  options: { q?: string | null; skip?: number; take?: number } = {}
): Promise<RegulatoryReport> {
  const where = regulatoryWhere(from, to, providerId, options.q);
  const [loans, total, documentTypes] = await Promise.all([
    prisma.loan.findMany({
      where,
      select: {
        id: true,
        loanNumber: true,
        status: true,
        providerId: true,
        borrowerId: true,
        terms: true,
        disbursementAccount: true,
        disbursementDate: true,
        maturityDate: true,
        principalAmount: true,
        principalOutstanding: true,
        interestOutstanding: true,
        feeOutstanding: true,
        penaltyOutstanding: true,
        taxOutstanding: true,
        daysPastDue: true,
        score: true,
        closedAt: true,
        provider: { select: { name: true } },
        product: { select: { name: true } },
        application: { select: { requestedAmount: true } },
        borrower: { select: { fullName: true, phoneNumber: true, coreBanking: { select: { values: true } } } },
      },
      orderBy: [{ disbursementDate: 'desc' }, { loanNumber: 'desc' }],
      skip: options.skip,
      take: options.take ?? 50_000,
    }),
    prisma.loan.count({ where }),
    prisma.documentType.findMany({
      where: { scope: 'GLOBAL', kind: 'TEXT', status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  const borrowerIds = [...new Set(loans.map((l) => l.borrowerId))];
  const documents = new Map<string, Record<string, string>>();
  const history = new Map<string, { id: string; providerId: string }[]>();
  for (const ids of chunks(borrowerIds)) {
    const [docs, earlier] = await Promise.all([
      documentTypes.length
        ? prisma.borrowerDocument.findMany({
            where: { borrowerId: { in: ids }, documentTypeId: { in: documentTypes.map((t) => t.id) }, status: 'APPROVED' },
            select: { borrowerId: true, documentTypeId: true, value: true },
          })
        : Promise.resolve([]),
      prisma.loan.findMany({
        where: { borrowerId: { in: ids }, disbursementDate: { not: null } },
        select: { id: true, borrowerId: true, providerId: true },
        orderBy: [{ disbursementDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    for (const doc of docs) {
      if (!doc.value) continue;
      const byType = documents.get(doc.borrowerId) ?? {};
      byType[doc.documentTypeId] = doc.value;
      documents.set(doc.borrowerId, byType);
    }
    for (const loan of earlier) {
      const list = history.get(loan.borrowerId) ?? [];
      list.push(loan);
      history.set(loan.borrowerId, list);
    }
  }

  const rows = loans.map((loan): RegulatoryRow => {
    const [firstName, middleName, lastName] = splitFullName(loan.borrower.fullName);
    const profile = profileValues(loan.borrower.coreBanking?.values);
    const income = profile.netMonthlyIncome;
    let terms: ReturnType<typeof parseTerms> | null = null;
    try {
      terms = parseTerms(loan.terms);
    } catch {
      terms = null;
    }
    // The borrower's nth loan with this provider.
    const cycle = (history.get(loan.borrowerId) ?? []).filter((l) => l.providerId === loan.providerId).findIndex((l) => l.id === loan.id) + 1;
    return {
      loanId: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      provider: loan.provider.name,
      product: loan.product.name,
      firstName,
      middleName,
      lastName,
      phoneNumber: loan.borrower.phoneNumber,
      account: loan.disbursementAccount,
      region: text(profile.region),
      city: text(profile.city),
      occupation: text(profile.occupation),
      monthlyIncome: typeof income === 'number' ? income : null,
      documents: documents.get(loan.borrowerId) ?? {},
      applicationAmount: toCents(loan.application.requestedAmount),
      approvedAmount: toCents(loan.principalAmount),
      disbursementDate: loan.disbursementDate ? dayToIso(dayFromDate(loan.disbursementDate)) : '',
      maturityDate: loan.maturityDate ? dayToIso(dayFromDate(loan.maturityDate)) : null,
      durationDays: terms?.durationDays ?? null,
      repaymentFrequency: terms ? repaymentFrequency(terms.durationDays, terms.installmentCount) : '',
      interestRate: terms ? describeInterest(terms) : '',
      serviceCharge: terms ? describeServiceFee(terms) : '',
      outstanding: loan.status === 'ACTIVE' ? outstandingOf(loan) : 0,
      daysPastDue: loan.status === 'ACTIVE' ? loan.daysPastDue : 0,
      classification:
        loan.status === 'PAID_OFF' ? 'Closed' : loan.status === 'WRITTEN_OFF' ? 'Written off' : nbeLabel(classifyNbe(loan.daysPastDue)),
      settlementDate: loan.status === 'PAID_OFF' && loan.closedAt ? dayToIso(dayFromDate(loan.closedAt)) : null,
      loanCycle: cycle > 0 ? cycle : 1,
      creditScore: loan.score,
    };
  });

  return { documentTypes, rows, total };
}

// ----------------------------------------
// Receipts
// ----------------------------------------

/** Every receipt in the period, posted or reversed, for reconciliation against the bank. */
export async function receiptsReport(from: Day, to: Day, providerId?: string | null) {
  const receipts = await prisma.repayment.findMany({
    where: {
      valueDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
      ...(providerId ? { loan: { providerId } } : {}),
    },
    include: {
      loan: {
        select: {
          loanNumber: true,
          provider: { select: { name: true } },
          borrower: { select: { phoneNumber: true, fullName: true } },
        },
      },
    },
    orderBy: [{ valueDate: 'asc' }, { receivedAt: 'asc' }],
    take: 50_000,
  });
  return receipts.map((r) => ({
    receiptNo: r.receiptNo,
    valueDate: dayToIso(dayFromDate(r.valueDate)),
    receivedAt: r.receivedAt.toISOString(),
    loanNumber: r.loan.loanNumber,
    provider: r.loan.provider.name,
    borrowerPhone: r.loan.borrower.phoneNumber,
    borrowerName: r.loan.borrower.fullName,
    channel: r.channel,
    externalReference: r.externalReference,
    amount: toCents(r.amount),
    principal: toCents(r.principalPortion),
    interest: toCents(r.interestPortion),
    fee: toCents(r.feePortion),
    penalty: toCents(r.penaltyPortion),
    tax: toCents(r.taxPortion),
    excess: toCents(r.excessPortion),
    status: r.status,
    reversedAt: r.reversedAt?.toISOString() ?? null,
    reversalReason: r.reversalReason,
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
