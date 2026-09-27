import { z } from 'zod';
import type { LoanProduct, LoanProvider } from '@prisma/client';
import { boolish, parsePenaltyRules, productPricingSchema } from './terms';
import { DEFAULT_PROVIDER_ICON, isValidProviderIcon, MAX_PROVIDER_ICON_URI_LENGTH, PROVIDER_ICON_ERROR } from '../provider-icon';
import { loanCycleSchema, parseLoanCycle } from './scoring';
import { DOCUMENT_KIND_KEYS } from '../document-kinds';
import { parseDocumentTypeIds } from './document-requirements';

/** Validation for providers, products, taxes and terms — shared by maker and checker. */

const text = (max: number) => z.string().trim().max(max);

/** Core banking account numbers: optional, and stored as null rather than ''. */
const accountNumber = text(34)
  .regex(/^[0-9A-Za-z-]*$/, 'Account numbers contain only letters, digits and dashes.')
  .optional()
  .transform((v) => (v ? v : null));

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
  icon: z
    .string()
    .trim()
    .max(MAX_PROVIDER_ICON_URI_LENGTH, PROVIDER_ICON_ERROR)
    .refine(isValidProviderIcon, PROVIDER_ICON_ERROR)
    .default(DEFAULT_PROVIDER_ICON),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  fundingAccountNo: accountNumber,
  collectionAccountNo: accountNumber,
  nplThresholdDays: z.coerce.number().int().min(1).max(3650).default(90),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export type ProviderInput = z.infer<typeof providerSchema>;

/** What a document type may change after it is created. */
export const documentTypeUpdateSchema = z.object({
  name: text(100).min(2, 'Name the document.'),
  description: text(300).default(''),
  requiresExpiry: boolish.default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

/**
 * A kind of document borrowers provide. Its owner (the bank, or one provider)
 * and what the borrower provides (a photo, a PDF, either, or a typed answer)
 * are fixed once created: changing either would change who approved the
 * documents already on file, or what they were approved as.
 */
export const documentTypeSchema = documentTypeUpdateSchema
  .extend({
    scope: z.enum(['GLOBAL', 'PRODUCT']),
    providerId: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .transform((v) => v || null),
    kind: z.enum(DOCUMENT_KIND_KEYS).default('FILE'),
  })
  .transform((t) => ({ ...t, providerId: t.scope === 'GLOBAL' ? null : t.providerId }))
  .refine((t) => t.scope === 'GLOBAL' || t.providerId, { message: 'Choose the provider this document belongs to.', path: ['providerId'] });

export type DocumentTypeInput = z.infer<typeof documentTypeSchema>;

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
    /** The provider's document types this product asks for, on top of the bank's. */
    documentTypeIds: z
      .array(z.string().trim().min(1).max(40))
      .max(20, 'A product can ask for at most 20 documents.')
      .default([])
      .transform((ids) => [...new Set(ids)]),
    eligibilityFilter: z
      .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(500))
      .nullable()
      .default(null),
    /** Saved customer list; when set, only borrowers on it may apply. */
    eligibilityListId: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .transform((v) => v || null),
    cycleConfig: loanCycleSchema.nullable().default(null),
  }).superRefine((product, ctx) => {
    // Grades split borrowers by score; without scoring every borrower would sit in the lowest.
    if (product.cycleConfig && !product.requiresScoring && product.cycleConfig.grades.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['cycleConfig', 'grades'],
        message: 'Grades need credit scoring. Turn on "Use the provider\'s credit score", or keep a single grade.',
      });
    }
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

/**
 * A tax rule's fields from a request body, which the form sends at the top
 * level alongside anything else. The Settings page used to read them from a
 * `tax` key the form never sent, so every tax request failed validation.
 */
export function taxPayload(body: Record<string, unknown>) {
  const { name, ratePercent, appliesToFee, appliesToInterest, appliesToPenalty, status } = body;
  return { name, ratePercent, appliesToFee, appliesToInterest, appliesToPenalty, status };
}

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
    icon: p.icon,
    displayOrder: p.displayOrder,
    fundingAccountNo: p.fundingAccountNo,
    collectionAccountNo: p.collectionAccountNo,
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
    documentTypeIds: parseDocumentTypeIds(p.documentTypeIds),
    eligibilityFilter,
    eligibilityListId: p.eligibilityListId,
    cycleConfig: parseLoanCycle(p.cycleConfig),
  };
}
