import { z } from 'zod';
import prisma from './prisma';
import { ApiError } from './errors';
import { acquireAppLock, locks, type TxClient } from './db-lock';
import { createAuditLogInTx } from './audit-log';
import { hasPermission } from './permissions';
import { centsToDecimal, parseUserAmount, toCents } from './money';
import { invalidateSettingsCache, SETTINGS_BY_KEY, validateSettingValue } from './settings';
import { provisionChartOfAccounts } from './accounting/ledger';
import { productSchema, providerSchema, taxRuleSchema, termsSchema } from './lending/catalog';
import { scoringModelSchema, tiersSchema } from './lending/scoring';
import {
  postCapitalInTx,
  recordRepaymentInTx,
  refundCreditInTx,
  remitTaxInTx,
  reverseRepaymentInTx,
  writeOffLoanInTx,
  type Actor,
} from './lending/loan-service';
import { resolveDisbursementInTx } from './lending/disbursement';
import { linkPhoneToBorrower } from './lending/borrower-identity';
import { parseEthiopianMobile } from './format';
import type { SessionUser } from './types';

/**
 * Maker–checker.
 *
 * Every change that alters what borrowers are charged, what they may borrow,
 * or the books themselves is recorded as a PendingChange and applied only when
 * a second person approves it. The maker can never approve their own request,
 * and a provider-scoped checker only sees their provider's queue.
 *
 * The previous SME console routed most settings through approvals but kept
 * the direct-write endpoints alongside, so anyone with update rights could
 * skip the checker entirely. Here there are no direct-write endpoints for
 * anything in the registry below: the only path to apply one is `decideChange`.
 *
 * Payloads are validated twice — when requested, so the maker sees mistakes
 * immediately, and again when applied, because the world may have moved on.
 */

const amountString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => parseUserAmount(v) !== null, 'Enter a positive amount with at most two decimals.');

const reference = z
  .string()
  .trim()
  .min(3, 'Enter a reference.')
  .max(60)
  .regex(/^[\w./:-]+$/, 'References use letters, digits and . / : - _ only.');

const reason = z.string().trim().min(5, 'Give a reason.').max(1000);

/** Stored in the 251XXXXXXXXX form, whatever the operator typed. */
const phoneNumber = z
  .string()
  .trim()
  .transform((v) => parseEthiopianMobile(v) ?? '')
  .refine((v) => v.length > 0, 'Enter an Ethiopian mobile number, such as 0911223344.');

interface Handler<T> {
  label: string;
  /** Module whose `approve` right the checker also needs (plus approvals.approve). */
  module: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Resolves the provider the change belongs to, for scoping. */
  providerOf: (tx: TxClient, payload: T, entityId: string | null) => Promise<string | null>;
  apply: (tx: TxClient, payload: T, entityId: string | null, actor: Actor) => Promise<string | null | void>;
}

function handler<T>(h: Handler<T>): Handler<T> {
  return h;
}

/** The product's provider, once its customer list is confirmed to belong to that provider. */
async function providerOfProduct(tx: TxClient, p: z.infer<typeof productSchema>) {
  if (p.eligibilityListId) {
    const list = await tx.eligibilityList.findUnique({ where: { id: p.eligibilityListId }, select: { providerId: true } });
    if (!list || list.providerId !== p.providerId) {
      throw new ApiError(400, "Choose one of this provider's customer lists.", 'eligibilityListId');
    }
  }
  return p.providerId;
}

async function providerOfLoan(tx: TxClient, loanId: string) {
  const loan = await tx.loan.findUnique({ where: { id: loanId }, select: { providerId: true } });
  if (!loan) throw new ApiError(404, 'Loan not found.');
  return loan.providerId;
}

export const CHANGE_HANDLERS = {
  'Provider.CREATE': handler({
    label: 'Create provider',
    module: 'providers',
    schema: providerSchema,
    providerOf: async () => null,
    apply: async (tx, p) => {
      const clash = await tx.loanProvider.findFirst({ where: { OR: [{ code: p.code }, { name: p.name }] } });
      if (clash) throw new ApiError(409, 'A provider with this code or name already exists.');
      const provider = await tx.loanProvider.create({ data: p });
      await provisionChartOfAccounts(tx, provider.id);
      return provider.id;
    },
  }),

  'Provider.UPDATE': handler({
    label: 'Update provider',
    module: 'providers',
    schema: providerSchema,
    providerOf: async (_tx, _p, id) => id,
    apply: async (tx, p, id) => {
      if (!id) throw new ApiError(400, 'Missing provider.');
      const clash = await tx.loanProvider.findFirst({
        where: { OR: [{ code: p.code }, { name: p.name }], NOT: { id } },
      });
      if (clash) throw new ApiError(409, 'Another provider already uses this code or name.');
      await tx.loanProvider.update({ where: { id }, data: p });
    },
  }),

  'Product.CREATE': handler({
    label: 'Create product',
    module: 'products',
    schema: productSchema,
    providerOf: providerOfProduct,
    apply: async (tx, p) => {
      // Checked again: the list may have been deleted while this waited.
      await providerOfProduct(tx, p);
      const created = await tx.loanProduct.create({ data: { ...productColumns(p), providerId: p.providerId, status: 'DRAFT' } });
      return created.id;
    },
  }),

  'Product.UPDATE': handler({
    label: 'Update product',
    module: 'products',
    schema: productSchema,
    providerOf: providerOfProduct,
    apply: async (tx, p, id) => {
      if (!id) throw new ApiError(400, 'Missing product.');
      await providerOfProduct(tx, p);
      const existing = await tx.loanProduct.findUnique({ where: { id }, select: { providerId: true } });
      if (!existing || existing.providerId !== p.providerId) throw new ApiError(404, 'Product not found.');
      // Loans already issued keep their own terms snapshot; this only prices new loans.
      await tx.loanProduct.update({ where: { id }, data: productColumns(p) });
    },
  }),

  'Product.STATUS': handler({
    label: 'Change product status',
    module: 'products',
    schema: z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }),
    providerOf: async (tx, _p, id) => {
      const product = await tx.loanProduct.findUnique({ where: { id: id ?? '' }, select: { providerId: true } });
      if (!product) throw new ApiError(404, 'Product not found.');
      return product.providerId;
    },
    apply: async (tx, p, id) => {
      const product = await tx.loanProduct.findUnique({
        where: { id: id ?? '' },
        include: { tiers: true, provider: { include: { scoringParameters: { select: { id: true } } } } },
      });
      if (!product) throw new ApiError(404, 'Product not found.');
      if (p.status === 'ACTIVE' && product.requiresScoring) {
        if (product.provider.scoringParameters.length === 0) {
          throw new ApiError(409, 'The provider has no scoring model yet; the product would refuse every borrower.');
        }
        if (product.tiers.length === 0) {
          throw new ApiError(409, 'Add loan amount tiers before activating a product that uses scoring.');
        }
      }
      await tx.loanProduct.update({ where: { id: product.id }, data: { status: p.status } });
    },
  }),

  'Product.TIERS': handler({
    label: 'Replace loan amount tiers',
    module: 'products',
    schema: z.object({ tiers: tiersSchema }),
    providerOf: async (tx, _p, id) => {
      const product = await tx.loanProduct.findUnique({ where: { id: id ?? '' }, select: { providerId: true } });
      if (!product) throw new ApiError(404, 'Product not found.');
      return product.providerId;
    },
    apply: async (tx, p, id) => {
      const product = await tx.loanProduct.findUnique({ where: { id: id ?? '' } });
      if (!product) throw new ApiError(404, 'Product not found.');
      const max = toCents(product.maxAmount);
      if (p.tiers.some((t) => toCents(t.maxAmount) > max)) {
        throw new ApiError(400, 'A tier amount is above the product maximum.');
      }
      await tx.loanAmountTier.deleteMany({ where: { productId: product.id } });
      if (p.tiers.length) {
        await tx.loanAmountTier.createMany({
          data: p.tiers.map((t) => ({
            productId: product.id,
            minScore: t.minScore,
            maxScore: t.maxScore,
            maxAmount: centsToDecimal(toCents(t.maxAmount)),
          })),
        });
      }
    },
  }),

  'ScoringModel.UPDATE': handler({
    label: 'Replace scoring model',
    module: 'credit-scoring',
    schema: z.object({ parameters: scoringModelSchema }),
    providerOf: async (_tx, _p, id) => id,
    apply: async (tx, p, id) => {
      if (!id) throw new ApiError(400, 'Missing provider.');
      const provider = await tx.loanProvider.findUnique({ where: { id }, select: { id: true } });
      if (!provider) throw new ApiError(404, 'Provider not found.');
      const existing = await tx.scoringParameter.findMany({ where: { providerId: id }, select: { id: true } });
      if (existing.length) {
        await tx.scoringRule.deleteMany({ where: { parameterId: { in: existing.map((e) => e.id) } } });
        await tx.scoringParameter.deleteMany({ where: { providerId: id } });
      }
      for (const [index, parameter] of p.parameters.entries()) {
        await tx.scoringParameter.create({
          data: {
            providerId: id,
            name: parameter.name,
            weight: parameter.weight,
            sortOrder: index,
            rules: { create: parameter.rules },
          },
        });
      }
    },
  }),

  'TaxRule.CREATE': handler({
    label: 'Create tax rule',
    module: 'settings',
    schema: taxRuleSchema,
    providerOf: async () => null,
    apply: async (tx, p) => {
      const created = await tx.taxRule.create({ data: p });
      return created.id;
    },
  }),

  'TaxRule.UPDATE': handler({
    label: 'Update tax rule',
    module: 'settings',
    schema: taxRuleSchema,
    providerOf: async () => null,
    apply: async (tx, p, id) => {
      if (!id) throw new ApiError(400, 'Missing tax rule.');
      await tx.taxRule.update({ where: { id }, data: p });
    },
  }),

  'Terms.PUBLISH': handler({
    label: 'Publish terms & conditions',
    module: 'providers',
    schema: termsSchema,
    providerOf: async (_tx, p) => p.providerId,
    apply: async (tx, p) => {
      const latest = await tx.termsVersion.findFirst({
        where: { providerId: p.providerId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.termsVersion.updateMany({ where: { providerId: p.providerId, isActive: true }, data: { isActive: false } });
      const created = await tx.termsVersion.create({
        data: { providerId: p.providerId, version: (latest?.version ?? 0) + 1, content: p.content, isActive: true },
      });
      return created.id;
    },
  }),

  'Settings.UPDATE': handler({
    label: 'Change settings',
    module: 'settings',
    schema: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    providerOf: async () => null,
    apply: async (tx, p, _id, actor) => {
      for (const [key, raw] of Object.entries(p)) {
        const checked = validateSettingValue(key, raw);
        if (!checked.ok) throw new ApiError(400, checked.error);
        await tx.systemSetting.upsert({
          where: { key },
          create: { key, value: String(checked.value), updatedById: actor.id },
          update: { value: String(checked.value), updatedById: actor.id },
        });
      }
    },
  }),

  'Capital.POST': handler({
    label: 'Capital movement',
    module: 'accounting',
    schema: z.object({
      direction: z.enum(['INJECT', 'WITHDRAW']),
      amount: amountString,
      reference,
      note: z.string().trim().max(200).optional(),
    }),
    providerOf: async (_tx, _p, id) => id,
    apply: async (tx, p, id, actor) => {
      if (!id) throw new ApiError(400, 'Missing provider.');
      const journal = await postCapitalInTx(
        tx,
        { providerId: id, amount: parseUserAmount(p.amount)!, direction: p.direction, reference: p.reference, note: p.note },
        actor
      );
      return journal.journalNo;
    },
  }),

  'TaxRemittance.POST': handler({
    label: 'Remit tax',
    module: 'accounting',
    schema: z.object({ amount: amountString, reference }),
    providerOf: async (_tx, _p, id) => id,
    apply: async (tx, p, id, actor) => {
      if (!id) throw new ApiError(400, 'Missing provider.');
      const journal = await remitTaxInTx(tx, { providerId: id, amount: parseUserAmount(p.amount)!, reference: p.reference }, actor);
      return journal.journalNo;
    },
  }),

  'Repayment.MANUAL': handler({
    label: 'Record manual repayment',
    module: 'repayments',
    schema: z.object({ amount: amountString, reference, note: z.string().trim().max(500).optional() }),
    providerOf: (tx, _p, id) => providerOfLoan(tx, id ?? ''),
    apply: async (tx, p, id, actor) => {
      const posted = await recordRepaymentInTx(tx, {
        loanId: id ?? '',
        amount: parseUserAmount(p.amount)!,
        channel: 'MANUAL',
        externalReference: p.reference,
        actor,
      });
      return posted.repayment.receiptNo;
    },
  }),

  'Repayment.REVERSE': handler({
    label: 'Reverse repayment',
    module: 'repayments',
    schema: z.object({ reason }),
    providerOf: async (tx, _p, id) => {
      const repayment = await tx.repayment.findUnique({ where: { id: id ?? '' }, select: { loan: { select: { providerId: true } } } });
      if (!repayment) throw new ApiError(404, 'Repayment not found.');
      return repayment.loan.providerId;
    },
    apply: async (tx, p, id, actor) => {
      const { journal } = await reverseRepaymentInTx(tx, id ?? '', p.reason, actor);
      return journal.journalNo;
    },
  }),

  'Loan.WRITE_OFF': handler({
    label: 'Write off loan',
    module: 'loans',
    schema: z.object({ reason }),
    providerOf: (tx, _p, id) => providerOfLoan(tx, id ?? ''),
    apply: async (tx, p, id, actor) => {
      const { journal } = await writeOffLoanInTx(tx, id ?? '', p.reason, actor);
      return journal.journalNo;
    },
  }),

  'Loan.REFUND': handler({
    label: 'Refund overpayment',
    module: 'loans',
    schema: z.object({ amount: amountString, reference }),
    providerOf: (tx, _p, id) => providerOfLoan(tx, id ?? ''),
    apply: async (tx, p, id, actor) => {
      const journal = await refundCreditInTx(tx, id ?? '', parseUserAmount(p.amount)!, p.reference, actor);
      return journal.journalNo;
    },
  }),

  'Disbursement.RESOLVE': handler({
    label: 'Resolve disbursement',
    module: 'disbursements',
    schema: z.object({
      resolution: z.enum(['CONFIRM', 'FAIL']),
      reference: z.string().trim().max(60).optional(),
      note: reason,
    }),
    providerOf: async (tx, _p, id) => {
      const attempt = await tx.disbursementAttempt.findUnique({
        where: { id: id ?? '' },
        select: { loan: { select: { providerId: true } } },
      });
      if (!attempt) throw new ApiError(404, 'Disbursement not found.');
      return attempt.loan.providerId;
    },
    apply: async (tx, p, id, actor) => {
      if (p.resolution === 'CONFIRM' && !p.reference) {
        throw new ApiError(400, 'Enter the core banking reference that proves the transfer.');
      }
      await resolveDisbursementInTx(tx, id ?? '', p.resolution, { reference: p.reference, note: p.note }, actor);
    },
  }),

  /**
   * Moves a borrower onto a new phone number.
   *
   * Sign-in recognises most changed numbers on its own, through the bank
   * account they hold. This is for the rest: the borrower changed bank account
   * as well, the old number was recycled to somebody else, or two borrowers
   * hold the account so the automatic match refused to guess. It needs two
   * people because it decides whose loans somebody can see and repay.
   *
   * Nothing is rewritten onto a new key — the loans never moved, because they
   * were never keyed by the phone number.
   */
  'Borrower.PHONE_CHANGE': handler({
    label: 'Change borrower phone number',
    module: 'borrowers',
    schema: z.object({ newPhoneNumber: phoneNumber, reason }),
    providerOf: async () => null,
    apply: async (tx, p, id, actor) => {
      const borrowerId = id ?? '';
      const borrower = await tx.borrower.findUnique({
        where: { id: borrowerId },
        select: { phoneNumber: true },
      });
      if (!borrower) throw new ApiError(404, 'Borrower not found.');
      if (borrower.phoneNumber === p.newPhoneNumber) {
        throw new ApiError(400, 'That is already this borrower’s number.');
      }

      const { merge } = await linkPhoneToBorrower(tx, borrowerId, p.newPhoneNumber, 'APPROVAL', actor);

      await createAuditLogInTx(tx, {
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        action: 'BORROWER_PHONE_CHANGED',
        entity: 'Borrower',
        entityId: borrowerId,
        details: {
          previousPhone: borrower.phoneNumber,
          newPhone: p.newPhoneNumber,
          reason: p.reason,
          absorbedDuplicate: merge ? merge : null,
        },
      });

      return p.newPhoneNumber;
    },
  }),
};

export type ChangeKind = keyof typeof CHANGE_HANDLERS;

function productColumns(p: z.infer<typeof productSchema>) {
  return {
    code: p.code,
    name: p.name,
    description: p.description,
    minAmount: centsToDecimal(toCents(p.minAmount)),
    maxAmount: centsToDecimal(toCents(p.maxAmount)),
    durationDays: p.durationDays,
    installmentCount: p.installmentCount,
    serviceFeeType: p.serviceFeeType,
    serviceFeeValue: p.serviceFeeValue,
    interestType: p.interestType,
    interestValue: p.interestValue,
    interestBasis: p.interestBasis,
    accrueInterestAfterMaturity: p.accrueInterestAfterMaturity,
    penaltyRules: JSON.stringify(p.penaltyRules),
    allowConcurrentLoans: p.allowConcurrentLoans,
    requiresReview: p.requiresReview,
    requiresScoring: p.requiresScoring,
    requiredDocuments: JSON.stringify(p.requiredDocuments),
    eligibilityFilter: p.eligibilityFilter ? JSON.stringify(p.eligibilityFilter) : null,
    eligibilityListId: p.eligibilityListId,
    cycleConfig: p.cycleConfig ? JSON.stringify(p.cycleConfig) : null,
  };
}

function splitKind(kind: ChangeKind) {
  const [entityType, action] = kind.split('.') as [string, string];
  return { entityType, action };
}

/** Field-level diff so reviewers see exactly what changed. */
export function diffFields(previous: Record<string, unknown> | null | undefined, next: Record<string, unknown>): string[] {
  if (!previous) return Object.keys(next);
  return Object.keys(next).filter((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null));
}

export interface RequestChangeInput {
  kind: ChangeKind;
  entityId?: string | null;
  payload: unknown;
  previousData?: Record<string, unknown> | null;
  summary: string;
  user: SessionUser;
}

export async function requestChange(input: RequestChangeInput) {
  const h = CHANGE_HANDLERS[input.kind] as unknown as Handler<Record<string, unknown>>;
  const payload = h.schema.parse(input.payload);
  const { entityType, action } = splitKind(input.kind);

  return prisma.$transaction(async (tx) => {
    const providerId = await h.providerOf(tx, payload, input.entityId ?? null);
    if (input.user.providerId && providerId !== input.user.providerId) {
      throw new ApiError(404, 'Record not found.');
    }

    const duplicate = await tx.pendingChange.findFirst({
      where: {
        entityType,
        action,
        status: 'PENDING',
        entityId: input.entityId ?? null,
        ...(input.entityId ? {} : { createdById: input.user.id }),
      },
      select: { id: true },
    });
    if (duplicate && input.entityId) {
      throw new ApiError(409, 'A request of this kind is already waiting for approval for this record.');
    }

    const change = await tx.pendingChange.create({
      data: {
        entityType,
        entityId: input.entityId ?? null,
        action,
        payload: JSON.stringify(payload),
        previousData: input.previousData ? JSON.stringify(input.previousData) : null,
        changedFields: JSON.stringify(
          payload && typeof payload === 'object' ? diffFields(input.previousData, payload as Record<string, unknown>) : []
        ),
        summary: input.summary.slice(0, 1000),
        providerId,
        createdById: input.user.id,
      },
    });

    await createAuditLogInTx(tx, {
      actorId: input.user.id,
      actorName: input.user.fullName,
      action: 'CHANGE_REQUESTED',
      entity: entityType,
      entityId: input.entityId ?? undefined,
      details: { changeId: change.id, kind: input.kind, summary: input.summary },
    });
    return change;
  });
}

export function canDecide(user: SessionUser, kind: string): boolean {
  const h = (CHANGE_HANDLERS as unknown as Record<string, Handler<unknown>>)[kind];
  if (!h) return false;
  return hasPermission(user, 'approvals', 'approve') && hasPermission(user, h.module, 'approve');
}

export async function decideChange(
  changeId: string,
  decision: 'APPROVED' | 'REJECTED',
  user: SessionUser,
  comment?: string | null
): Promise<{ message: string; result: string | null; kind: string }> {
  const outcome = await prisma.$transaction(async (tx) => {
    await acquireAppLock(tx, locks.change(changeId));
    const change = await tx.pendingChange.findUnique({ where: { id: changeId } });
    if (!change || (user.providerId && change.providerId !== user.providerId)) {
      throw new ApiError(404, 'Change request not found.');
    }
    const kind = `${change.entityType}.${change.action}`;
    if (change.status !== 'PENDING') {
      throw new ApiError(409, `This request was already ${change.status.toLowerCase()}.`);
    }
    if (change.createdById === user.id) {
      throw new ApiError(403, 'You cannot decide a change you requested yourself.');
    }
    if (!canDecide(user, kind)) {
      throw new ApiError(403, 'You do not have approval rights for this kind of change.');
    }

    const actor: Actor = { id: user.id, name: user.fullName, type: 'ADMIN' };

    if (decision === 'REJECTED') {
      await tx.pendingChange.update({
        where: { id: changeId },
        data: { status: 'REJECTED', decidedById: user.id, decidedAt: new Date(), comment: comment ?? null },
      });
      await createAuditLogInTx(tx, {
        actorId: user.id,
        actorName: user.fullName,
        action: 'CHANGE_REJECTED',
        entity: change.entityType,
        entityId: change.entityId ?? undefined,
        details: { changeId, kind, comment },
      });
      return { message: 'Change request rejected.', result: null, kind };
    }

    const h = (CHANGE_HANDLERS as unknown as Record<string, Handler<unknown>>)[kind];
    if (!h) throw new ApiError(409, `No handler is registered for ${kind}.`);
    const payload = h.schema.parse(JSON.parse(change.payload));
    const result = (await h.apply(tx, payload, change.entityId, actor)) ?? null;

    await tx.pendingChange.update({
      where: { id: changeId },
      data: {
        status: 'APPROVED',
        decidedById: user.id,
        decidedAt: new Date(),
        comment: comment ?? null,
        entityId: change.entityId ?? (typeof result === 'string' && kind.endsWith('.CREATE') ? result : null),
      },
    });
    await createAuditLogInTx(tx, {
      actorId: user.id,
      actorName: user.fullName,
      action: 'CHANGE_APPROVED',
      entity: change.entityType,
      entityId: change.entityId ?? undefined,
      details: { changeId, kind, comment, result },
    });
    return { message: 'Change approved and applied.', result, kind };
  });

  if (outcome.kind === 'Settings.UPDATE') invalidateSettingsCache();
  return outcome;
}

export async function withdrawChange(changeId: string, user: SessionUser, comment?: string | null) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.pendingChange.updateMany({
      where: { id: changeId, createdById: user.id, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: new Date(), comment: comment ?? null },
    });
    if (claim.count !== 1) throw new ApiError(409, 'Only your own pending requests can be withdrawn.');
    await createAuditLogInTx(tx, {
      actorId: user.id,
      actorName: user.fullName,
      action: 'CHANGE_WITHDRAWN',
      entity: 'PendingChange',
      entityId: changeId,
    });
  });
}

/** Settings that are not sensitive may be written directly by someone with settings.update. */
export function settingNeedsApproval(key: string, approvalSwitchOn: boolean) {
  return Boolean(SETTINGS_BY_KEY.get(key)?.sensitive) && approvalSwitchOn;
}
