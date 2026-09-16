import { z } from 'zod';
import { centsToDecimal, RATE_SCALE, toCents, toRateMicro, type Cents, type DecimalInput } from '@/lib/money';

/**
 * Loan pricing, as agreed at origination.
 *
 * The previous system recomputed every balance from the *current* product row
 * on every read, so editing a product's fee rules silently repriced every loan
 * already on the books — including ones that were already repaid. A loan now
 * carries a snapshot of its terms, taken when it is created and never changed.
 */

export const PENALTY_TYPES = ['FIXED', 'PERCENT_PRINCIPAL', 'PERCENT_BALANCE'] as const;
export type PenaltyType = (typeof PENALTY_TYPES)[number];

export const PENALTY_FREQUENCIES = ['DAILY', 'ONCE'] as const;
export type PenaltyFrequency = (typeof PENALTY_FREQUENCIES)[number];

export const SERVICE_FEE_TYPES = ['NONE', 'FIXED', 'PERCENT'] as const;
export type ServiceFeeType = (typeof SERVICE_FEE_TYPES)[number];

export const INTEREST_TYPES = ['NONE', 'FIXED_DAILY', 'PERCENT_DAILY'] as const;
export type InterestType = (typeof INTEREST_TYPES)[number];

export const INTEREST_BASES = ['SIMPLE', 'COMPOUND'] as const;
export type InterestBasis = (typeof INTEREST_BASES)[number];

/**
 * A boolean from JSON or a form. `z.coerce.boolean()` is not usable here: it
 * runs `Boolean(value)`, so the string "false" becomes true — a tax marked as
 * not applying to penalties would be saved as applying.
 */
export const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', 'off'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'on');

const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,6})?$/.test(v), 'Must be a non-negative number with at most 6 decimals.');

export const penaltyRuleSchema = z
  .object({
    /** First day past due the rule applies to. Day 1 is the day after the due date. */
    fromDay: z.coerce.number().int().min(1).max(3650),
    /** Last day it applies to, inclusive. Null runs until the loan is settled. */
    toDay: z
      .union([z.coerce.number().int().min(1).max(3650), z.null(), z.literal('')])
      .transform((v) => (v === '' ? null : v)),
    type: z.enum(PENALTY_TYPES),
    value: decimalString,
    frequency: z.enum(PENALTY_FREQUENCIES),
  })
  .refine((r) => r.toDay === null || r.toDay >= r.fromDay, {
    message: 'The last day must not be before the first day.',
    path: ['toDay'],
  });

export type PenaltyRule = z.infer<typeof penaltyRuleSchema>;

export interface TaxSnapshot {
  name: string;
  ratePercent: string;
  fee: boolean;
  interest: boolean;
  penalty: boolean;
}

export interface LoanTerms {
  version: 1;
  currency: string;
  productCode: string;
  productName: string;
  principal: string;
  durationDays: number;
  installmentCount: number;
  serviceFee: { type: ServiceFeeType; value: string };
  interest: {
    type: InterestType;
    value: string;
    basis: InterestBasis;
    afterMaturity: boolean;
  };
  penaltyRules: PenaltyRule[];
  taxes: TaxSnapshot[];
}

/** Terms with every decimal already converted, so the daily loop does no parsing. */
export interface CompiledTerms {
  principal: Cents;
  durationDays: number;
  installmentCount: number;
  feeFixed: Cents;
  feeRateMicro: number;
  interestType: InterestType;
  interestFixed: Cents;
  interestRateMicro: number;
  compound: boolean;
  afterMaturity: boolean;
  penalties: CompiledPenalty[];
  taxOnFeeMicro: number;
  taxOnInterestMicro: number;
  taxOnPenaltyMicro: number;
}

export interface CompiledPenalty {
  fromDay: number;
  toDay: number;
  type: PenaltyType;
  fixed: Cents;
  rateMicro: number;
  once: boolean;
}

export function compileTerms(terms: LoanTerms): CompiledTerms {
  const sumRates = (pick: (t: TaxSnapshot) => boolean) =>
    terms.taxes.filter(pick).reduce((sum, t) => sum + toRateMicro(t.ratePercent), 0);

  return {
    principal: toCents(terms.principal),
    durationDays: terms.durationDays,
    installmentCount: Math.max(1, terms.installmentCount),
    feeFixed: terms.serviceFee.type === 'FIXED' ? toCents(terms.serviceFee.value) : 0,
    feeRateMicro: terms.serviceFee.type === 'PERCENT' ? toRateMicro(terms.serviceFee.value) : 0,
    interestType: terms.interest.type,
    interestFixed: terms.interest.type === 'FIXED_DAILY' ? toCents(terms.interest.value) : 0,
    interestRateMicro:
      terms.interest.type === 'PERCENT_DAILY' ? toRateMicro(terms.interest.value) : 0,
    compound: terms.interest.basis === 'COMPOUND',
    afterMaturity: terms.interest.afterMaturity,
    penalties: terms.penaltyRules
      .map((rule) => ({
        fromDay: rule.fromDay,
        toDay: rule.toDay ?? Number.POSITIVE_INFINITY,
        type: rule.type,
        fixed: rule.type === 'FIXED' ? toCents(rule.value) : 0,
        rateMicro: rule.type === 'FIXED' ? 0 : toRateMicro(rule.value),
        once: rule.frequency === 'ONCE',
      }))
      .filter((rule) => rule.fixed > 0 || rule.rateMicro > 0),
    taxOnFeeMicro: sumRates((t) => t.fee),
    taxOnInterestMicro: sumRates((t) => t.interest),
    taxOnPenaltyMicro: sumRates((t) => t.penalty),
  };
}

export function parseTerms(raw: string): LoanTerms {
  const parsed = JSON.parse(raw) as LoanTerms;
  if (parsed?.version !== 1) throw new Error('Unsupported loan terms version.');
  return parsed;
}

// ----------------------------------------
// Product pricing validation
// ----------------------------------------

/** 100% a day is already absurd; anything above is a typo, not a product. */
const MAX_DAILY_RATE_MICRO = 100 * RATE_SCALE;
const MAX_FEE_RATE_MICRO = 100 * RATE_SCALE;

export const productPricingSchema = z
  .object({
    minAmount: decimalString,
    maxAmount: decimalString,
    durationDays: z.coerce.number().int().min(1).max(3650),
    installmentCount: z.coerce.number().int().min(1).max(120),
    serviceFeeType: z.enum(SERVICE_FEE_TYPES),
    serviceFeeValue: decimalString,
    interestType: z.enum(INTEREST_TYPES),
    interestValue: decimalString,
    interestBasis: z.enum(INTEREST_BASES),
    accrueInterestAfterMaturity: boolish,
    penaltyRules: z.array(penaltyRuleSchema).max(20),
  })
  .superRefine((p, ctx) => {
    const min = toCents(p.minAmount);
    const max = toCents(p.maxAmount);
    if (min <= 0) ctx.addIssue({ code: 'custom', path: ['minAmount'], message: 'Minimum amount must be above zero.' });
    if (max < min) ctx.addIssue({ code: 'custom', path: ['maxAmount'], message: 'Maximum amount must not be below the minimum.' });
    if (p.installmentCount > p.durationDays) {
      ctx.addIssue({ code: 'custom', path: ['installmentCount'], message: 'There cannot be more installments than days in the term.' });
    }
    if (p.serviceFeeType === 'PERCENT' && toRateMicro(p.serviceFeeValue) > MAX_FEE_RATE_MICRO) {
      ctx.addIssue({ code: 'custom', path: ['serviceFeeValue'], message: 'A service fee cannot exceed 100% of the principal.' });
    }
    if (p.serviceFeeType !== 'NONE' && toRateMicro(p.serviceFeeValue) === 0) {
      ctx.addIssue({ code: 'custom', path: ['serviceFeeValue'], message: 'Enter the fee, or set the fee type to none.' });
    }
    if (p.interestType === 'PERCENT_DAILY' && toRateMicro(p.interestValue) > MAX_DAILY_RATE_MICRO) {
      ctx.addIssue({ code: 'custom', path: ['interestValue'], message: 'A daily rate above 100% is not accepted.' });
    }
    if (p.interestType !== 'NONE' && toRateMicro(p.interestValue) === 0) {
      ctx.addIssue({ code: 'custom', path: ['interestValue'], message: 'Enter the daily charge, or set the interest type to none.' });
    }
    p.penaltyRules.forEach((rule, index) => {
      if (rule.type !== 'FIXED' && toRateMicro(rule.value) > MAX_DAILY_RATE_MICRO) {
        ctx.addIssue({ code: 'custom', path: ['penaltyRules', index, 'value'], message: 'A penalty rate above 100% is not accepted.' });
      }
    });
    // Two daily rules covering the same day would both charge it. That is a
    // legitimate design (a flat fee plus a rate), so it is allowed — but two
    // rules of the *same type* overlapping is almost always a typo in a tier table.
    const rules = p.penaltyRules;
    for (let i = 0; i < rules.length; i += 1) {
      for (let j = i + 1; j < rules.length; j += 1) {
        const a = rules[i];
        const b = rules[j];
        if (a.type !== b.type || a.frequency !== b.frequency) continue;
        const aEnd = a.toDay ?? Number.POSITIVE_INFINITY;
        const bEnd = b.toDay ?? Number.POSITIVE_INFINITY;
        if (a.fromDay <= bEnd && b.fromDay <= aEnd) {
          ctx.addIssue({
            code: 'custom',
            path: ['penaltyRules', j, 'fromDay'],
            message: `Overlaps rule ${i + 1} (same type and frequency).`,
          });
        }
      }
    }
  });

export type ProductPricing = z.infer<typeof productPricingSchema>;

export interface ProductLike {
  code: string;
  name: string;
  durationDays: number;
  installmentCount: number;
  serviceFeeType: string;
  serviceFeeValue: DecimalInput;
  interestType: string;
  interestValue: DecimalInput;
  interestBasis: string;
  accrueInterestAfterMaturity: boolean;
  penaltyRules: string;
}

export interface TaxRuleLike {
  name: string;
  ratePercent: DecimalInput;
  appliesToFee: boolean;
  appliesToInterest: boolean;
  appliesToPenalty: boolean;
}

export function parsePenaltyRules(raw: string | null | undefined): PenaltyRule[] {
  if (!raw) return [];
  try {
    const parsed = z.array(penaltyRuleSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The snapshot a new loan is created with. */
export function buildTerms(
  product: ProductLike,
  principal: Cents,
  taxes: TaxRuleLike[],
  currency: string
): LoanTerms {
  const decimal = (value: DecimalInput) => {
    const micro = toRateMicro(value);
    const whole = Math.floor(micro / RATE_SCALE);
    const fraction = String(micro % RATE_SCALE).padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : String(whole);
  };

  return {
    version: 1,
    currency,
    productCode: product.code,
    productName: product.name,
    principal: centsToDecimal(principal),
    durationDays: product.durationDays,
    installmentCount: Math.max(1, product.installmentCount),
    serviceFee: {
      type: (SERVICE_FEE_TYPES as readonly string[]).includes(product.serviceFeeType)
        ? (product.serviceFeeType as ServiceFeeType)
        : 'NONE',
      value: decimal(product.serviceFeeValue),
    },
    interest: {
      type: (INTEREST_TYPES as readonly string[]).includes(product.interestType)
        ? (product.interestType as InterestType)
        : 'NONE',
      value: decimal(product.interestValue),
      basis: product.interestBasis === 'COMPOUND' ? 'COMPOUND' : 'SIMPLE',
      afterMaturity: Boolean(product.accrueInterestAfterMaturity),
    },
    penaltyRules: parsePenaltyRules(product.penaltyRules),
    taxes: taxes
      .filter((t) => toRateMicro(t.ratePercent) > 0)
      .map((t) => ({
        name: t.name,
        ratePercent: decimal(t.ratePercent),
        fee: t.appliesToFee,
        interest: t.appliesToInterest,
        penalty: t.appliesToPenalty,
      })),
  };
}
