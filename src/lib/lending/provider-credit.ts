import prisma from '@/lib/prisma';
import { centsToNumber, toCents } from '@/lib/money';
import { getSettings } from '@/lib/settings';
import { parsePenaltyRules } from './terms';
import { describeFee, describeInterest } from './product-view';
import { borrowerPhoneNumbers } from './borrower-identity';
import { visibleToBorrower } from './eligibility-lists';
import { evaluateEligibility } from './eligibility';
import { providerScoresOnCoreBanking, refreshCoreBankingProfile } from './core-banking-profile';
import { productChecklists } from './borrower-documents';

/**
 * One provider's whole offer to one borrower: what they may borrow, from which
 * product, and how much of their limit is already spent.
 *
 * The borrower dashboard needs this for every product of the provider it is
 * showing. Asking the per-product eligibility endpoint once per product would
 * work, but it refreshes core banking each time — so a provider with four
 * products meant four statement pulls from the bank, and four of the borrower's
 * thirty eligibility checks a minute. Here the bank is asked once, up front,
 * and the products are then evaluated against the stored figures.
 */

export interface ProductOffer {
  id: string;
  name: string;
  description: string;
  /** The product's own floor and ceiling, for the "credit limit x to y" line. */
  minAmount: number;
  maxAmount: number;
  durationDays: number;
  installmentCount: number;
  serviceFee: string;
  interest: string;
  penalties: string[];
  requiresReview: boolean;
  /** What this borrower is approved for, before deducting what they owe. */
  ceiling: number;
  /** What they can draw right now. Zero unless `eligible`. */
  available: number;
  /** The smallest loan this product writes. */
  floor: number;
  eligible: boolean;
  reason: string;
  /** Principal owed to this provider, plus amounts awaiting a decision. */
  committed: number;
  /** Documents this product asks for that are not yet approved; applying waits for them. */
  documentsNeeded: number;
  /** Of those, how many are already sent and waiting for review. */
  documentsWaiting: number;
}

export interface ProviderCredit {
  providerId: string;
  currency: string;
  /** The best ceiling across the provider's products — the borrower's limit. */
  maxLimit: number;
  /** The largest single loan they could take right now. */
  available: number;
  /** Principal owed to this provider, plus anything awaiting a decision. */
  committed: number;
  offers: ProductOffer[];
}

function describePenalty(rule: ReturnType<typeof parsePenaltyRules>[number]): string {
  const amount =
    rule.type === 'FIXED'
      ? Number(rule.value).toLocaleString('en-US', { minimumFractionDigits: 2 })
      : `${Number(rule.value)}%`;
  const when = rule.frequency === 'ONCE' ? 'once' : 'per day';
  const range = rule.toDay ? `days ${rule.fromDay}–${rule.toDay}` : `from day ${rule.fromDay}`;
  return `${amount} ${when}, ${range} late`;
}

/**
 * Brings the borrower's core-banking figures up to date once for the whole
 * provider, if any of its products scores on them. Never call this per
 * product: `refreshCoreBankingProfile` takes no lock, so parallel callers each
 * pull a fresh statement instead of sharing one.
 */
async function prepareCoreBanking(borrowerId: string, providerId: string, products: { requiresScoring: boolean }[]) {
  if (!products.some((p) => p.requiresScoring)) return;
  if (!(await providerScoresOnCoreBanking(prisma, providerId))) return;
  try {
    await refreshCoreBankingProfile(borrowerId);
  } catch (error) {
    // Eligibility then decides what to do without fresh figures.
    console.error('[core-banking] profile refresh failed', error);
  }
}

export async function providerCredit(
  borrower: { id: string; phoneNumber: string; status: string; isNpl: boolean },
  providerId: string
): Promise<ProviderCredit> {
  const numbers = await borrowerPhoneNumbers(prisma, borrower);
  const [products, settings] = await Promise.all([
    prisma.loanProduct.findMany({
      where: { providerId, status: 'ACTIVE', provider: { status: 'ACTIVE' }, ...visibleToBorrower(numbers) },
      orderBy: { name: 'asc' },
    }),
    getSettings(),
  ]);
  const currency = String(settings['platform.currency'] || 'ETB');

  await prepareCoreBanking(borrower.id, providerId, products);
  const checklists = await productChecklists(prisma, borrower.id, products);

  const offers = await Promise.all(
    products.map(async (product): Promise<ProductOffer> => {
      const result = await evaluateEligibility(prisma, borrower, product.id);
      const outstanding = (checklists.get(product.id) ?? []).filter((item) => !item.satisfied);
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        minAmount: centsToNumber(toCents(product.minAmount)),
        maxAmount: centsToNumber(toCents(product.maxAmount)),
        durationDays: product.durationDays,
        installmentCount: product.installmentCount,
        serviceFee: describeFee(product.serviceFeeType, product.serviceFeeValue.toString()),
        interest: describeInterest(product.interestType, product.interestValue.toString(), product.interestBasis),
        penalties: parsePenaltyRules(product.penaltyRules).map(describePenalty),
        requiresReview: product.requiresReview,
        ceiling: centsToNumber(result.limits.ceiling),
        available: result.eligible ? centsToNumber(result.maxAmount) : 0,
        floor: centsToNumber(result.minAmount),
        eligible: result.eligible,
        reason: result.reason,
        committed: centsToNumber(result.limits.outstandingWithProvider),
        documentsNeeded: outstanding.length,
        documentsWaiting: outstanding.filter((item) => item.status === 'PENDING').length,
      };
    })
  );

  return {
    providerId,
    currency,
    maxLimit: offers.reduce((best, o) => Math.max(best, o.ceiling), 0),
    available: offers.reduce((best, o) => Math.max(best, o.available), 0),
    // Exposure is provider-wide, so every offer that got as far as computing it
    // reports the same figure; the early refusals report zero.
    committed: offers.reduce((most, o) => Math.max(most, o.committed), 0),
    offers,
  };
}
