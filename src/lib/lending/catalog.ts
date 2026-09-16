import { z } from 'zod';
import type { LoanProduct, LoanProvider } from '@prisma/client';
import { boolish, parsePenaltyRules, productPricingSchema } from './terms';
import { loanCycleSchema, parseLoanCycle } from './scoring';

/** Validation for providers, products, taxes and terms — shared by maker and checker. */

const text = (max: number) => z.string().trim().max(max);

export const providerSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_-]{2,20}$/, 'Use 2–20 capital letters, digits, dashes or underscores (e.g. PRO0001).'),
  name: text(100).min(2, 'Enter the provider name.'),
  colorHex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #E0A70B.')
    .default('#E0A70B'),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  fundingAccountNo: text(34)
    .regex(/^[0-9A-Za-z-]*$/, 'Account numbers contain only letters, digits and dashes.')
    .optional()
    .transform((v) => (v ? v : null)),
  nplThresholdDays: z.coerce.number().int().min(1).max(3650).default(90),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export type ProviderInput = z.infer<typeof providerSchema>;

export const requiredDocumentSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,40}$/, 'Keys use lowercase letters, digits and underscores.'),
  name: text(100).min(2),
  description: text(300).optional(),
});

export const productSchema = productPricingSchema.and(
  z.object({
    providerId: z.string().min(1),
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_-]{2,20}$/, 'Use 2–20 capital letters, digits, dashes or underscores.'),
    name: text(100).min(2, 'Enter the product name.'),
    description: text(2000).default(''),
    allowConcurrentLoans: boolish.default(false),
    requiresReview: boolish.default(false),
    requiresScoring: boolish.default(true),
    requiredDocuments: z.array(requiredDocumentSchema).max(20).default([]),
    eligibilityFilter: z
      .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(500))
      .nullable()
      .default(null),
    cycleConfig: loanCycleSchema.nullable().default(null),
  })
);

export type ProductInput = z.infer<typeof productSchema>;

export const taxRuleSchema = z
  .object({
    name: text(60).min(2, 'Name the tax.'),
    ratePercent: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((v) => /^\d{1,2}(\.\d{1,6})?$/.test(v) || v === '100', 'Enter a rate between 0 and 100.'),
    appliesToFee: boolish,
    appliesToInterest: boolish,
    appliesToPenalty: boolish,
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .refine((t) => t.appliesToFee || t.appliesToInterest || t.appliesToPenalty, {
    message: 'Choose at least one charge the tax applies to.',
    path: ['appliesToFee'],
  });

export type TaxRuleInput = z.infer<typeof taxRuleSchema>;

export const termsSchema = z.object({
  providerId: z.string().min(1),
  content: z.string().trim().min(20, 'Terms must be at least a sentence long.').max(50_000),
});

// ----------------------------------------
// Stored record → form values (also the "before" side of an approval diff)
// ----------------------------------------


function decimalText(value: { toString(): string }) {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function providerFormValues(p: LoanProvider): ProviderInput {
  return {
    code: p.code,
    name: p.name,
    colorHex: p.colorHex,
    displayOrder: p.displayOrder,
    fundingAccountNo: p.fundingAccountNo,
    nplThresholdDays: p.nplThresholdDays,
    status: p.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
  };
}

export function productFormValues(p: LoanProduct) {
  let eligibilityFilter: Record<string, string> | null = null;
  try {
    eligibilityFilter = p.eligibilityFilter ? JSON.parse(p.eligibilityFilter) : null;
  } catch {
    eligibilityFilter = null;
  }
  let requiredDocuments: { key: string; name: string; description?: string }[] = [];
  try {
    requiredDocuments = JSON.parse(p.requiredDocuments || '[]');
  } catch {
    requiredDocuments = [];
  }
  return {
    providerId: p.providerId,
    code: p.code,
    name: p.name,
    description: p.description,
    minAmount: decimalText(p.minAmount),
    maxAmount: decimalText(p.maxAmount),
    durationDays: p.durationDays,
    installmentCount: p.installmentCount,
    serviceFeeType: p.serviceFeeType,
    serviceFeeValue: decimalText(p.serviceFeeValue),
    interestType: p.interestType,
    interestValue: decimalText(p.interestValue),
    interestBasis: p.interestBasis,
    accrueInterestAfterMaturity: p.accrueInterestAfterMaturity,
    penaltyRules: parsePenaltyRules(p.penaltyRules),
    allowConcurrentLoans: p.allowConcurrentLoans,
    requiresReview: p.requiresReview,
    requiresScoring: p.requiresScoring,
    requiredDocuments,
    eligibilityFilter,
    cycleConfig: parseLoanCycle(p.cycleConfig),
  };
}
