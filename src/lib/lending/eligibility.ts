import type { LoanProduct, LoanProvider } from '@prisma/client';
import prisma from '@/lib/prisma';
import type { TxClient } from '@/lib/db-lock';
import { toCents, type Cents } from '@/lib/money';
import { getSettings } from '@/lib/settings';
import { OPEN_LOAN_STATUSES } from '@/lib/types';
import { borrowerPhoneNumbers } from './borrower-identity';
import {
  cyclePercent,
  normalizeFieldName,
  parseLoanCycle,
  scoreBorrower,
  type ScoreBreakdown,
  type ScoringOperator,
} from './scoring';

export interface BorrowerFeatures {
  values: Record<string, unknown>;
  history: {
    disbursedLoans: number;
    paidOffLoans: number;
    onTimeLoans: number;
    lateLoans: number;
    writtenOffLoans: number;
    openLoans: number;
    worstDaysPastDue: number;
  };
}

/**
 * Everything a scoring rule may refer to: the provider's uploaded data for this
 * borrower, plus the borrower's own history on the platform.
 */
export async function getBorrowerFeatures(
  client: TxClient,
  borrower: { id: string; phoneNumber: string },
  providerId: string
): Promise<BorrowerFeatures> {
  // Data rows are keyed by phone number, so match every number this borrower
  // has used: a provider's upload against their old number is still about them.
  const keys = await borrowerPhoneNumbers(client, borrower);
  const [rows, loans] = await Promise.all([
    client.borrowerDataRow.findMany({
      where: { borrowerKey: { in: keys }, config: { providerId } },
      orderBy: { updatedAt: 'asc' },
      select: { data: true },
    }),
    client.loan.findMany({
      where: { borrowerId: borrower.id },
      select: { status: true, repaymentBehavior: true, maxDaysPastDue: true },
    }),
  ]);

  const values: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) values[normalizeFieldName(key)] = value;
    } catch {
      // A malformed row is skipped rather than failing the whole check.
    }
  }

  const disbursed = loans.filter((l) => ['ACTIVE', 'PAID_OFF', 'WRITTEN_OFF'].includes(l.status));
  const history = {
    disbursedLoans: disbursed.length,
    paidOffLoans: loans.filter((l) => l.status === 'PAID_OFF').length,
    onTimeLoans: loans.filter((l) => l.status === 'PAID_OFF' && l.repaymentBehavior !== 'LATE').length,
    lateLoans: loans.filter((l) => l.repaymentBehavior === 'LATE').length,
    writtenOffLoans: loans.filter((l) => l.status === 'WRITTEN_OFF').length,
    openLoans: loans.filter((l) => (OPEN_LOAN_STATUSES as string[]).includes(l.status)).length,
    worstDaysPastDue: disbursed.reduce((max, l) => Math.max(max, l.maxDaysPastDue), 0),
  };

  for (const [key, value] of Object.entries(history)) values[normalizeFieldName(key)] = value;
  return { values, history };
}

/** The built-in history fields a rule can use without any uploaded data. */
export const HISTORY_FIELDS = [
  'disbursedLoans',
  'paidOffLoans',
  'onTimeLoans',
  'lateLoans',
  'writtenOffLoans',
  'openLoans',
  'worstDaysPastDue',
];

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  score: number | null;
  maxScore: number | null;
  breakdown: ScoreBreakdown[];
  minAmount: Cents;
  maxAmount: Cents;
  limits: {
    productMax: Cents;
    tierMax: Cents | null;
    cyclePercent: number | null;
    outstandingWithProvider: Cents;
  };
}

type ProductWithProvider = LoanProduct & { provider: LoanProvider };

function refuse(product: ProductWithProvider | null, reason: string, extra: Partial<EligibilityResult> = {}): EligibilityResult {
  return {
    eligible: false,
    reason,
    score: null,
    maxScore: null,
    breakdown: [],
    minAmount: product ? toCents(product.minAmount) : 0,
    maxAmount: 0,
    limits: {
      productMax: product ? toCents(product.maxAmount) : 0,
      tierMax: null,
      cyclePercent: null,
      outstandingWithProvider: 0,
    },
    ...extra,
  };
}

/**
 * Whether a borrower may borrow from a product, and how much.
 *
 * Differences from the previous implementation, each of which let a borrower
 * borrow more than intended:
 *
 *  - Outstanding exposure is the principal still owed. It used to be
 *    `loanAmount − repaidAmount`, and repaidAmount included interest, fees and
 *    penalties, so every santim of interest paid raised the borrower's limit.
 *  - Loans awaiting disbursement and applications awaiting review count
 *    against the limit; they used to be invisible to it.
 *  - An existing loan on a product that does not allow concurrent loans blocks
 *    new borrowing too, not only the other way round.
 *  - A tier table with gaps or overlaps cannot be saved (see `tiersSchema`).
 *
 * Callers that act on the answer (submitting an application) must call this
 * inside a transaction holding the borrower lock, so two simultaneous
 * applications cannot both pass against the same limit.
 */
export async function evaluateEligibility(
  client: TxClient,
  borrower: { id: string; phoneNumber: string; status: string; isNpl: boolean },
  productId: string,
  options: { excludeApplicationId?: string } = {}
): Promise<EligibilityResult> {
  const product = await client.loanProduct.findUnique({
    where: { id: productId },
    include: { provider: true },
  });
  if (!product || product.status !== 'ACTIVE' || product.provider.status !== 'ACTIVE') {
    return refuse(product, 'This loan product is not available.');
  }

  const settings = await getSettings();
  if (!settings['lending.applicationsEnabled']) {
    return refuse(product, 'New applications are paused at the moment. Please try again later.');
  }
  if (borrower.status !== 'ACTIVE') return refuse(product, 'Your account cannot apply for loans. Please contact support.');
  if (borrower.isNpl) {
    return refuse(product, 'You have a loan that is seriously overdue. Please repay it before applying again.');
  }
  if (settings['lending.refuseAfterWriteOff']) {
    const writtenOff = await client.loan.count({ where: { borrowerId: borrower.id, status: 'WRITTEN_OFF' } });
    if (writtenOff > 0) {
      return refuse(product, 'A previous loan of yours was not repaid, so new loans are not available. Please contact support.');
    }
  }

  const [openLoans, pendingApplications] = await Promise.all([
    client.loan.findMany({
      where: { borrowerId: borrower.id, status: { in: OPEN_LOAN_STATUSES } },
      select: {
        productId: true,
        providerId: true,
        principalAmount: true,
        principalOutstanding: true,
        status: true,
        product: { select: { name: true, allowConcurrentLoans: true } },
      },
    }),
    client.loanApplication.findMany({
      where: {
        borrowerId: borrower.id,
        status: 'SUBMITTED',
        ...(options.excludeApplicationId ? { id: { not: options.excludeApplicationId } } : {}),
      },
      select: { productId: true, providerId: true, requestedAmount: true },
    }),
  ]);

  const maxOpen = Number(settings['lending.maxOpenLoansPerBorrower']) || 3;
  if (openLoans.length + pendingApplications.length >= maxOpen) {
    return refuse(product, `You can have at most ${maxOpen} open loans and applications at a time.`);
  }
  if (openLoans.some((l) => l.productId === product.id)) {
    return refuse(product, `You already have an open ${product.name} loan. Repay it before applying again.`);
  }
  if (pendingApplications.some((a) => a.productId === product.id)) {
    return refuse(product, `Your ${product.name} application is still being reviewed.`);
  }
  if (!product.allowConcurrentLoans && (openLoans.length > 0 || pendingApplications.length > 0)) {
    return refuse(product, `${product.name} cannot be taken alongside another loan. Repay your open loans first.`);
  }
  const exclusive = openLoans.find((l) => !l.product.allowConcurrentLoans);
  if (exclusive) {
    return refuse(product, `Your ${exclusive.product.name} loan must be repaid before you take another loan.`);
  }

  const features = await getBorrowerFeatures(client, borrower, product.providerId);

  if (product.eligibilityFilter) {
    try {
      const filter = JSON.parse(product.eligibilityFilter) as Record<string, string>;
      const matches = Object.entries(filter).every(([field, allowed]) => {
        const actual = String(features.values[normalizeFieldName(field)] ?? '').trim().toLowerCase();
        return String(allowed)
          .split(',')
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean)
          .includes(actual);
      });
      if (!matches) return refuse(product, 'This loan product is not available for your profile.');
    } catch {
      return refuse(product, 'This loan product is not available right now.');
    }
  }

  const productMin = toCents(product.minAmount);
  const productMax = toCents(product.maxAmount);
  let cap = productMax;
  let score: number | null = null;
  let maxScore: number | null = null;
  let breakdown: ScoreBreakdown[] = [];
  let tierMax: Cents | null = null;

  if (product.requiresScoring) {
    const parameters = await client.scoringParameter.findMany({
      where: { providerId: product.providerId },
      orderBy: { sortOrder: 'asc' },
      include: { rules: true },
    });
    if (parameters.length === 0) {
      return refuse(product, 'This lender is not accepting applications yet.');
    }
    const scored = scoreBorrower(
      parameters.map((p) => ({
        name: p.name,
        weight: p.weight,
        rules: p.rules.map((r) => ({
          field: r.field,
          operator: r.operator as ScoringOperator,
          value: r.value,
          score: r.score,
        })),
      })),
      features.values
    );
    score = scored.total;
    maxScore = scored.maxPossible;
    breakdown = scored.breakdown;

    const tier = await client.loanAmountTier.findFirst({
      where: { productId: product.id, minScore: { lte: score }, maxScore: { gte: score } },
      select: { maxAmount: true },
    });
    tierMax = tier ? toCents(tier.maxAmount) : 0;
    if (!tierMax) {
      return refuse(product, 'Your credit score does not qualify for this product yet.', {
        score,
        maxScore,
        breakdown,
        limits: { productMax, tierMax: 0, cyclePercent: null, outstandingWithProvider: 0 },
      });
    }
    cap = Math.min(cap, tierMax);
  }

  let percent: number | null = null;
  const cycle = parseLoanCycle(product.cycleConfig);
  if (cycle) {
    const count = cycle.metric === 'ON_TIME_LOANS' ? features.history.onTimeLoans : features.history.paidOffLoans;
    percent = cyclePercent(cycle, count);
    cap = Math.floor((cap * percent) / 100);
  }

  const outstandingWithProvider =
    openLoans
      .filter((l) => l.providerId === product.providerId)
      .reduce(
        (sum, l) => sum + (l.status === 'ACTIVE' ? toCents(l.principalOutstanding) : toCents(l.principalAmount)),
        0
      ) +
    pendingApplications
      .filter((a) => a.providerId === product.providerId)
      .reduce((sum, a) => sum + toCents(a.requestedAmount), 0);

  // Whole currency units: nobody is offered a loan of 4,999.37.
  const available = Math.floor(Math.max(0, Math.min(cap, productMax) - outstandingWithProvider) / 100) * 100;
  const limits = { productMax, tierMax, cyclePercent: percent, outstandingWithProvider };

  if (available < productMin) {
    return refuse(
      product,
      outstandingWithProvider > 0
        ? 'You have reached your limit with this lender. Repay your open loans to borrow again.'
        : 'Your current limit is below the minimum amount for this product.',
      { score, maxScore, breakdown, limits }
    );
  }

  return {
    eligible: true,
    reason: 'You are eligible.',
    score,
    maxScore,
    breakdown,
    minAmount: productMin,
    maxAmount: available,
    limits,
  };
}

export async function evaluateEligibilityNow(
  borrower: { id: string; phoneNumber: string; status: string; isNpl: boolean },
  productId: string
) {
  return evaluateEligibility(prisma, borrower, productId);
}
