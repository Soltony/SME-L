import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { acquireAppLock, locks } from '@/lib/db-lock';
import { createAuditLogInTx } from '@/lib/audit-log';
import { centsToDecimal, formatMoney, toCents, type Cents } from '@/lib/money';
import { nextNumber } from '@/lib/numbering';
import { missingDocuments, parseRequiredDocuments } from '@/lib/documents';
import { notifyBorrower } from '@/lib/notifications';
import { getSettings } from '@/lib/settings';
import { evaluateEligibility } from './eligibility';
import { createLoanFromApplicationInTx, type Actor } from './loan-service';
import { executeDisbursement, type DisbursementRunStatus } from './disbursement';

export interface SubmitApplicationInput {
  borrower: { id: string; phoneNumber: string; status: string; isNpl: boolean };
  productId: string;
  amount: Cents;
  accountNumber: string;
  acceptedTermsId: string | null;
}

export interface SubmitApplicationResult {
  applicationId: string;
  applicationNo: string;
  status: 'SUBMITTED' | 'DISBURSED' | 'APPROVED' | 'FAILED';
  loanId: string | null;
  disbursement: DisbursementRunStatus | null;
}

/**
 * A borrower applies for a loan.
 *
 * Eligibility is evaluated again here, inside a transaction holding the
 * borrower lock, and the application is written in the same transaction. The
 * eligibility screen's answer is only advice: two taps on "Apply" in two tabs
 * would otherwise both pass against the same limit.
 */
export async function submitApplication(input: SubmitApplicationInput): Promise<SubmitApplicationResult> {
  const actor: Actor = { id: input.borrower.phoneNumber, type: 'BORROWER' };

  const created = await prisma.$transaction(async (tx) => {
    await acquireAppLock(tx, locks.borrower(input.borrower.id));

    const fresh = await tx.borrower.findUniqueOrThrow({
      where: { id: input.borrower.id },
      select: { id: true, phoneNumber: true, status: true, isNpl: true },
    });
    const eligibility = await evaluateEligibility(tx, fresh, input.productId);
    if (!eligibility.eligible) throw new ApiError(409, eligibility.reason);

    if (input.amount < eligibility.minAmount || input.amount > eligibility.maxAmount) {
      throw new ApiError(
        400,
        `Choose an amount between ${formatMoney(eligibility.minAmount)} and ${formatMoney(eligibility.maxAmount)}.`,
        'amount'
      );
    }

    const account = await tx.borrowerAccount.findUnique({
      where: { borrowerId_accountNumber: { borrowerId: fresh.id, accountNumber: input.accountNumber } },
    });
    if (!account) {
      // Only an account core banking returned for this borrower's own phone
      // number may receive the money. The previous system stored whatever
      // account number the browser sent.
      throw new ApiError(400, 'Choose one of your verified accounts.', 'accountNumber');
    }

    const product = await tx.loanProduct.findUniqueOrThrow({
      where: { id: input.productId },
      select: { id: true, providerId: true, requiresReview: true, name: true },
    });

    const activeTerms = await tx.termsVersion.findFirst({
      where: { providerId: product.providerId, isActive: true },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (activeTerms) {
      if (input.acceptedTermsId !== activeTerms.id) {
        throw new ApiError(400, 'Please read and accept the current terms and conditions.', 'acceptTerms');
      }
      await tx.termsAcceptance.upsert({
        where: { borrowerId_termsId: { borrowerId: fresh.id, termsId: activeTerms.id } },
        create: { borrowerId: fresh.id, termsId: activeTerms.id },
        update: {},
      });
    }

    const applicationNo = await nextNumber(tx, 'application');
    const application = await tx.loanApplication.create({
      data: {
        applicationNo,
        borrowerId: fresh.id,
        providerId: product.providerId,
        productId: product.id,
        requestedAmount: centsToDecimal(input.amount),
        score: eligibility.score,
        eligibleAmount: centsToDecimal(eligibility.maxAmount),
        disbursementAccount: account.accountNumber,
        status: 'SUBMITTED',
      },
    });

    await createAuditLogInTx(tx, {
      actorId: actor.id,
      actorType: 'BORROWER',
      action: 'APPLICATION_SUBMITTED',
      entity: 'LoanApplication',
      entityId: application.id,
      details: {
        applicationNo,
        product: product.name,
        amount: centsToDecimal(input.amount),
        score: eligibility.score,
        eligibleAmount: centsToDecimal(eligibility.maxAmount),
        requiresReview: product.requiresReview,
      },
    });

    let loanId: string | null = null;
    if (!product.requiresReview) {
      const { loan } = await createLoanFromApplicationInTx(tx, application.id, input.amount, actor);
      loanId = loan.id;
    }
    return { application, loanId, requiresReview: product.requiresReview };
  });

  if (!created.loanId) {
    const settings = await getSettings();
    void notifyBorrower({
      phone: input.borrower.phoneNumber,
      template: 'APPLICATION_RECEIVED',
      vars: {
        applicationNo: created.application.applicationNo,
        amount: formatMoney(input.amount, String(settings['platform.currency'] || 'ETB')),
      },
      entity: 'LoanApplication',
      entityId: created.application.id,
    });
    return {
      applicationId: created.application.id,
      applicationNo: created.application.applicationNo,
      status: 'SUBMITTED',
      loanId: null,
      disbursement: null,
    };
  }

  const disbursement = await executeDisbursement(created.loanId, actor);
  return {
    applicationId: created.application.id,
    applicationNo: created.application.applicationNo,
    status: disbursement === 'SUCCEEDED' ? 'DISBURSED' : disbursement === 'FAILED' ? 'FAILED' : 'APPROVED',
    loanId: created.loanId,
    disbursement,
  };
}

/**
 * A reviewer approves an application. The borrower's position is evaluated
 * again as of now — they may have taken another loan or fallen into arrears
 * since applying — and the reviewer can lower the amount but never raise it
 * above what the borrower qualifies for today.
 */
export async function approveApplication(
  applicationId: string,
  input: { amount: Cents | null; note: string | null },
  reviewer: { id: string; fullName: string; providerId: string | null }
) {
  const header = await prisma.loanApplication.findUnique({
    where: { id: applicationId },
    select: { borrowerId: true, providerId: true },
  });
  if (!header || (reviewer.providerId && header.providerId !== reviewer.providerId)) {
    throw new ApiError(404, 'Application not found.');
  }

  const actor: Actor = { id: reviewer.id, name: reviewer.fullName, type: 'ADMIN' };

  const loanId = await prisma.$transaction(async (tx) => {
    await acquireAppLock(tx, locks.borrower(header.borrowerId));
    const application = await tx.loanApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: {
        borrower: true,
        product: true,
        documents: { select: { documentKey: true } },
        answers: { select: { documentKey: true } },
      },
    });
    if (application.status !== 'SUBMITTED') {
      throw new ApiError(409, `This application is already ${application.status.toLowerCase()}.`);
    }

    const missing = missingDocuments(parseRequiredDocuments(application.product.requiredDocuments), {
      files: application.documents.map((d) => d.documentKey),
      answers: application.answers.map((a) => a.documentKey),
    });
    if (missing.length) {
      throw new ApiError(409, `Documents still missing: ${missing.map((d) => d.name).join(', ')}.`);
    }

    const eligibility = await evaluateEligibility(tx, application.borrower, application.productId, {
      excludeApplicationId: application.id,
    });
    if (!eligibility.eligible) {
      throw new ApiError(409, `The borrower no longer qualifies: ${eligibility.reason}`);
    }

    const requested = toCents(application.requestedAmount);
    const amount = input.amount ?? requested;
    if (amount > requested) throw new ApiError(400, 'The approved amount cannot exceed the amount requested.', 'amount');
    if (amount > eligibility.maxAmount) {
      throw new ApiError(400, `The borrower qualifies for at most ${formatMoney(eligibility.maxAmount)} today.`, 'amount');
    }
    if (amount < eligibility.minAmount) {
      throw new ApiError(400, `The amount is below the product minimum of ${formatMoney(eligibility.minAmount)}.`, 'amount');
    }

    await tx.loanApplication.update({
      where: { id: application.id },
      data: {
        reviewNote: input.note,
        reviewedById: reviewer.id,
        reviewedByName: reviewer.fullName,
        reviewedAt: new Date(),
      },
    });
    const { loan } = await createLoanFromApplicationInTx(tx, application.id, amount, actor);
    await createAuditLogInTx(tx, {
      actorId: reviewer.id,
      actorName: reviewer.fullName,
      action: 'APPLICATION_APPROVED',
      entity: 'LoanApplication',
      entityId: application.id,
      details: { applicationNo: application.applicationNo, amount: centsToDecimal(amount), note: input.note },
    });
    return loan.id;
  });

  const disbursement = await executeDisbursement(loanId, actor);
  return { loanId, disbursement };
}

export async function rejectApplication(
  applicationId: string,
  reason: string,
  reviewer: { id: string; fullName: string; providerId: string | null }
) {
  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId },
    include: { borrower: { select: { phoneNumber: true } } },
  });
  if (!application || (reviewer.providerId && application.providerId !== reviewer.providerId)) {
    throw new ApiError(404, 'Application not found.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const claim = await tx.loanApplication.updateMany({
      where: { id: applicationId, status: 'SUBMITTED' },
      data: {
        status: 'REJECTED',
        reviewNote: reason,
        reviewedById: reviewer.id,
        reviewedByName: reviewer.fullName,
        reviewedAt: new Date(),
      },
    });
    if (claim.count !== 1) throw new ApiError(409, 'This application has already been decided.');
    await createAuditLogInTx(tx, {
      actorId: reviewer.id,
      actorName: reviewer.fullName,
      action: 'APPLICATION_REJECTED',
      entity: 'LoanApplication',
      entityId: applicationId,
      details: { applicationNo: application.applicationNo, reason },
    });
    return true;
  });

  void notifyBorrower({
    phone: application.borrower.phoneNumber,
    template: 'APPLICATION_REJECTED',
    vars: { applicationNo: application.applicationNo, reason: reason ? ` Reason: ${reason}` : '' },
    entity: 'LoanApplication',
    entityId: applicationId,
  });
  return updated;
}

export async function cancelApplication(applicationId: string, borrower: { id: string; phoneNumber: string }) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.loanApplication.updateMany({
      where: { id: applicationId, borrowerId: borrower.id, status: 'SUBMITTED' },
      data: { status: 'CANCELLED' },
    });
    if (claim.count !== 1) throw new ApiError(409, 'This application can no longer be withdrawn.');
    await createAuditLogInTx(tx, {
      actorId: borrower.phoneNumber,
      actorType: 'BORROWER',
      action: 'APPLICATION_CANCELLED',
      entity: 'LoanApplication',
      entityId: applicationId,
    });
  });
}
