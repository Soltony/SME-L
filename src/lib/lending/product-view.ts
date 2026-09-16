import type { LoanProduct, LoanProvider } from '@prisma/client';
import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { centsToNumber, toCents, type Cents } from '@/lib/money';
import { dayToIso, today } from '@/lib/business-date';
import { getSettings } from '@/lib/settings';
import { parseRequiredDocuments } from '@/lib/documents';
import { quoteLoan } from './engine';
import { buildTerms, compileTerms, parsePenaltyRules } from './terms';

export interface ProductCard {
  id: string;
  code: string;
  name: string;
  description: string;
  providerId: string;
  providerName: string;
  providerColor: string;
  providerIcon: string;
  minAmount: number;
  maxAmount: number;
  durationDays: number;
  installmentCount: number;
  serviceFee: string;
  interest: string;
  hasPenalties: boolean;
  requiresReview: boolean;
  requiredDocuments: { key: string; name: string }[];
}

function describeFee(type: string, value: string) {
  if (type === 'FIXED') return `${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })} one-off`;
  if (type === 'PERCENT') return `${Number(value)}% one-off`;
  return 'None';
}

function describeInterest(type: string, value: string, basis: string) {
  if (type === 'FIXED_DAILY') return `${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })} per day`;
  if (type === 'PERCENT_DAILY') return `${Number(value)}% per day${basis === 'COMPOUND' ? ', compounding' : ''}`;
  return 'None';
}

export function productCard(
  p: LoanProduct & { provider: Pick<LoanProvider, 'name' | 'colorHex' | 'icon'> }
): ProductCard {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    providerId: p.providerId,
    providerName: p.provider.name,
    providerColor: p.provider.colorHex,
    providerIcon: p.provider.icon,
    minAmount: centsToNumber(toCents(p.minAmount)),
    maxAmount: centsToNumber(toCents(p.maxAmount)),
    durationDays: p.durationDays,
    installmentCount: p.installmentCount,
    serviceFee: describeFee(p.serviceFeeType, p.serviceFeeValue.toString()),
    interest: describeInterest(p.interestType, p.interestValue.toString(), p.interestBasis),
    hasPenalties: parsePenaltyRules(p.penaltyRules).length > 0,
    requiresReview: p.requiresReview,
    requiredDocuments: parseRequiredDocuments(p.requiredDocuments).map((d) => ({ key: d.key, name: d.name })),
  };
}

export interface QuoteView {
  currency: string;
  principal: number;
  fee: number;
  taxOnFee: number;
  interest: number;
  taxOnInterest: number;
  totalRepayable: number;
  disbursementDate: string;
  maturityDate: string;
  schedule: { number: number; dueDate: string; principal: number }[];
  penaltyRules: ReturnType<typeof parsePenaltyRules>;
}

/**
 * The cost of a loan repaid at maturity, computed with the same terms snapshot
 * and engine a real loan uses — so the calculator can never promise a figure
 * the loan then disagrees with.
 */
export async function quoteForProduct(
  productId: string,
  amount: Cents,
  options: { activeOnly: boolean }
): Promise<QuoteView> {
  const product = await prisma.loanProduct.findUnique({ where: { id: productId } });
  if (!product || (options.activeOnly && product.status !== 'ACTIVE')) {
    throw new ApiError(404, 'Product not found.');
  }
  if (amount < toCents(product.minAmount) || amount > toCents(product.maxAmount)) {
    throw new ApiError(400, 'The amount is outside this product’s limits.', 'amount');
  }
  const [taxes, settings] = await Promise.all([
    prisma.taxRule.findMany({ where: { status: 'ACTIVE' } }),
    getSettings(),
  ]);
  const currency = String(settings['platform.currency'] || 'ETB');
  const terms = buildTerms(product, amount, taxes, currency);
  const start = today();
  const quote = quoteLoan(compileTerms(terms), start);
  const n = centsToNumber;
  return {
    currency,
    principal: n(quote.principal),
    fee: n(quote.fee),
    taxOnFee: n(quote.taxOnFee),
    interest: n(quote.interest),
    taxOnInterest: n(quote.taxOnInterest),
    totalRepayable: n(quote.totalRepayable),
    disbursementDate: dayToIso(start),
    maturityDate: dayToIso(quote.maturityDay),
    schedule: quote.schedule.map((s) => ({ number: s.number, dueDate: dayToIso(s.dueDay), principal: n(s.principalDue) })),
    penaltyRules: terms.penaltyRules,
  };
}
