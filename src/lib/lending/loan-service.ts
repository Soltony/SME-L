import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { acquireAppLock, locks, type TxClient } from '@/lib/db-lock';
import { createAuditLogInTx } from '@/lib/audit-log';
import { centsToDecimal, toCents, type Cents } from '@/lib/money';
import { dateFromDay, dayFromDate, today, type Day } from '@/lib/business-date';
import { nextNumber } from '@/lib/numbering';
import { postJournal, reverseJournal } from '@/lib/accounting/ledger';
import { uuid } from '@/lib/jwt';
import { getSettings } from '@/lib/settings';
import {
  accrue,
  applyPayment,
  openLoan,
  repaymentBehavior,
  reversePayment,
  writeOff,
  type LoanState,
  type PaymentAllocation,
} from './engine';
import { buildTerms, compileTerms, parseTerms } from './terms';
import { saveState, stateFromRow, type LoanWithInstallments } from './loan-store';

export interface Actor {
  id: string;
  name?: string | null;
  type: 'ADMIN' | 'BORROWER' | 'SYSTEM' | 'EXTERNAL';
}

export const SYSTEM_ACTOR: Actor = { id: 'SYSTEM', name: 'System', type: 'SYSTEM' };

async function loadLoan(tx: TxClient, loanId: string): Promise<LoanWithInstallments> {
  const loan = await tx.loan.findUnique({ where: { id: loanId }, include: { installments: true } });
  if (!loan) throw new ApiError(404, 'Loan not found.');
  return loan;
}

function audit(tx: TxClient, actor: Actor, action: string, entityId: string, details?: unknown) {
  return createAuditLogInTx(tx, {
    actorId: actor.id,
    actorName: actor.name ?? undefined,
    actorType: actor.type,
    action,
    entity: 'Loan',
    entityId,
    details,
  });
}

// ----------------------------------------
// Provider funds
// ----------------------------------------

export interface FundPosition {
  cash: Cents;
  reserved: Cents;
  available: Cents;
}

export async function fundPosition(client: TxClient, providerId: string): Promise<FundPosition> {
  const [cashAccount, provider] = await Promise.all([
    client.ledgerAccount.findUnique({
      where: { providerId_systemKey: { providerId, systemKey: 'CASH' } },
      select: { balance: true },
    }),
    client.loanProvider.findUnique({ where: { id: providerId }, select: { reservedFunds: true } }),
  ]);
  const cash = toCents(cashAccount?.balance);
  const reserved = toCents(provider?.reservedFunds);
  return { cash, reserved, available: cash - reserved };
}

// ----------------------------------------
// Accrual
// ----------------------------------------

export interface AccrualOutcome {
  loanId: string;
  state: LoanState | null;
  interest: Cents;
  penalty: Cents;
  tax: Cents;
  journalNo: string | null;
}

/**
 * Brings a loan's balances and its ledger up to `toDay`. Called nightly by the
 * batch, and before every repayment and write-off so the money is always
 * applied to what is actually owed that day.
 */
export async function accrueLoanInTx(
  tx: TxClient,
  loanId: string,
  toDay: Day,
  actor: Actor = SYSTEM_ACTOR
): Promise<AccrualOutcome> {
  await acquireAppLock(tx, locks.loan(loanId));
  const loan = await loadLoan(tx, loanId);
  if (loan.status !== 'ACTIVE') {
    return { loanId, state: null, interest: 0, penalty: 0, tax: 0, journalNo: null };
  }

  const before = stateFromRow(loan);
  if (before.accruedThrough > toDay) {
    throw new ApiError(
      409,
      `Loan ${loan.loanNumber} is already accrued past that date; back-dated postings are not allowed.`
    );
  }

  const compiled = compileTerms(parseTerms(loan.terms));
  const result = accrue(before, compiled, toDay);
  if (result.state.accruedThrough === before.accruedThrough) {
    return { loanId, state: before, interest: 0, penalty: 0, tax: 0, journalNo: null };
  }

  const tax = result.taxOnInterest + result.taxOnPenalty;
  let journalNo: string | null = null;

  if (result.interest + result.penalty + tax > 0) {
    const posted = await postJournal(tx, {
      providerId: loan.providerId,
      loanId: loan.id,
      businessDay: toDay - 1,
      type: 'ACCRUAL',
      description:
        result.toDay - result.fromDay === 1
          ? `Accrual for ${loan.loanNumber}`
          : `Accrual for ${loan.loanNumber} (${result.toDay - result.fromDay} days)`,
      idempotencyKey: `ACCRUAL:${loan.id}:${result.fromDay}:${result.toDay}`,
      createdById: actor.id,
      lines: [
        { account: 'INTEREST_RECEIVABLE', debit: result.interest },
        { account: 'INTEREST_INCOME', credit: result.interest },
        { account: 'PENALTY_RECEIVABLE', debit: result.penalty },
        { account: 'PENALTY_INCOME', credit: result.penalty },
        { account: 'TAX_RECEIVABLE', debit: tax },
        { account: 'TAX_PAYABLE', credit: tax },
      ],
    });
    journalNo = posted.journalNo;
  }

  await saveState(tx, loan, before, result.state);
  return { loanId, state: result.state, interest: result.interest, penalty: result.penalty, tax, journalNo };
}

export async function accrueLoan(loanId: string, toDay: Day = today(), actor: Actor = SYSTEM_ACTOR) {
  return prisma.$transaction((tx) => accrueLoanInTx(tx, loanId, toDay, actor));
}

export interface AccrualBatchResult {
  toDay: Day;
  processed: number;
  posted: number;
  failed: number;
  interest: Cents;
  penalty: Cents;
  tax: Cents;
  errors: { loanId: string; message: string }[];
  nplFlagged: number;
}

/**
 * The nightly pass. Each loan is its own transaction: one loan whose terms or
 * accounts are broken is reported and skipped, it never stops the book.
 * Idempotent — a second run the same day finds nothing to do.
 */
export async function runAccrualBatch(options: { toDay?: Day; concurrency?: number } = {}) {
  const toDay = options.toDay ?? today();
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
  const result: AccrualBatchResult = {
    toDay,
    processed: 0,
    posted: 0,
    failed: 0,
    interest: 0,
    penalty: 0,
    tax: 0,
    errors: [],
    nplFlagged: 0,
  };

  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.loan.findMany({
      where: {
        status: 'ACTIVE',
        accruedThrough: { lt: dateFromDay(toDay) },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 200,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (let i = 0; i < page.length; i += concurrency) {
      const slice = page.slice(i, i + concurrency);
      const outcomes = await Promise.allSettled(slice.map(({ id }) => accrueLoan(id, toDay)));
      outcomes.forEach((outcome, index) => {
        result.processed += 1;
        if (outcome.status === 'fulfilled') {
          if (outcome.value.journalNo) result.posted += 1;
          result.interest += outcome.value.interest;
          result.penalty += outcome.value.penalty;
          result.tax += outcome.value.tax;
        } else {
          result.failed += 1;
          const reason = outcome.reason;
          result.errors.push({
            loanId: slice[index].id,
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    }
    if (page.length < 200) break;
  }

  result.nplFlagged = await refreshNplFlags();
  return result;
}

// ----------------------------------------
// NPL classification
// ----------------------------------------

/**
 * A borrower is NPL while any active loan is past its provider's threshold in
 * days past *due*. The previous job measured days since *disbursement*, so a
 * 90-day loan was classed non-performing on day 60 while still current, and it
 * never cleared the flag once the loan was repaid.
 */
export async function refreshNplFlags(borrowerId?: string, client: TxClient = prisma): Promise<number> {
  const filter = borrowerId ? `WHERE b.[id] = @P1` : '';
  const sql = `
    UPDATE b SET
      b.[isNpl] = x.[npl],
      b.[nplSince] = CASE
        WHEN x.[npl] = 1 AND b.[isNpl] = 0 THEN SYSUTCDATETIME()
        WHEN x.[npl] = 0 THEN NULL
        ELSE b.[nplSince] END
    FROM [dbo].[Borrower] b
    CROSS APPLY (
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM [dbo].[Loan] l
        JOIN [dbo].[LoanProvider] p ON p.[id] = l.[providerId]
        WHERE l.[borrowerId] = b.[id] AND l.[status] = 'ACTIVE' AND l.[daysPastDue] >= p.[nplThresholdDays]
      ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS [npl]
    ) x
    ${filter ? `${filter} AND` : 'WHERE'} b.[isNpl] <> x.[npl]`;
  return borrowerId ? client.$executeRawUnsafe(sql, borrowerId) : client.$executeRawUnsafe(sql);
}

// ----------------------------------------
// Origination & disbursement
// ----------------------------------------

/**
 * Turns an approved application into a loan awaiting disbursement and reserves
 * the principal against the provider's fund.
 *
 * Nothing is posted to the ledger and nothing accrues yet. The previous system
 * booked the loan, started charging interest and moved the provider's balance
 * *before* core banking was asked to send the money — and when the transfer
 * failed, the borrower was left owing interest and penalties on a loan they
 * never received.
 */
export async function createLoanFromApplicationInTx(
  tx: TxClient,
  applicationId: string,
  principal: Cents,
  actor: Actor
) {
  const application = await tx.loanApplication.findUnique({
    where: { id: applicationId },
    include: { product: true, provider: true },
  });
  if (!application) throw new ApiError(404, 'Application not found.');
  if (application.status !== 'SUBMITTED') {
    throw new ApiError(409, `This application is already ${application.status.toLowerCase()}.`);
  }
  if (application.provider.status !== 'ACTIVE') {
    throw new ApiError(409, 'The provider is not currently lending.');
  }
  const product = application.product;
  if (principal < toCents(product.minAmount) || principal > toCents(product.maxAmount)) {
    throw new ApiError(400, 'The amount is outside the product limits.');
  }

  await acquireAppLock(tx, locks.providerFunds(application.providerId));
  const funds = await fundPosition(tx, application.providerId);
  if (principal > funds.available) {
    throw new ApiError(409, 'The provider does not have enough available funds for this loan right now.');
  }

  const [taxes, settings] = await Promise.all([
    tx.taxRule.findMany({ where: { status: 'ACTIVE' } }),
    getSettings(),
  ]);
  const terms = buildTerms(product, principal, taxes, String(settings['platform.currency'] || 'ETB'));
  // Compiling proves the snapshot is usable before anything is written.
  openLoan(compileTerms(terms), today());

  const loanNumber = await nextNumber(tx, 'loan');
  const loan = await tx.loan.create({
    data: {
      loanNumber,
      applicationId: application.id,
      borrowerId: application.borrowerId,
      providerId: application.providerId,
      productId: application.productId,
      status: 'PENDING_DISBURSEMENT',
      principalAmount: centsToDecimal(principal),
      terms: JSON.stringify(terms),
      disbursementAccount: application.disbursementAccount,
      score: application.score,
    },
  });

  await tx.loanProvider.update({
    where: { id: application.providerId },
    data: { reservedFunds: { increment: centsToDecimal(principal) } },
  });

  const attempt = await tx.disbursementAttempt.create({
    data: {
      loanId: loan.id,
      attemptNo: 1,
      status: 'PENDING',
      requestId: uuid(),
      creditAccount: application.disbursementAccount,
      amount: centsToDecimal(principal),
      providerCode: application.provider.code,
    },
  });

  await tx.loanApplication.update({
    where: { id: application.id },
    data: { status: 'APPROVED', approvedAmount: centsToDecimal(principal), loanId: loan.id },
  });

  await audit(tx, actor, 'LOAN_CREATED', loan.id, {
    loanNumber,
    applicationNo: application.applicationNo,
    principal: centsToDecimal(principal),
    product: product.code,
  });

  return { loan, attempt };
}

export interface DisbursementOutcome {
  reference?: string | null;
  httpStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  note?: string | null;
}

/** Core banking confirmed the transfer: the loan goes on the books from today. */
export async function confirmDisbursementInTx(
  tx: TxClient,
  attemptId: string,
  outcome: DisbursementOutcome,
  actor: Actor,
  businessDay: Day = today()
) {
  const attemptRow = await tx.disbursementAttempt.findUnique({ where: { id: attemptId } });
  if (!attemptRow) throw new ApiError(404, 'Disbursement attempt not found.');

  const loanHeader = await tx.loan.findUnique({
    where: { id: attemptRow.loanId },
    select: { providerId: true },
  });
  if (!loanHeader) throw new ApiError(404, 'Loan not found.');

  await acquireAppLock(tx, locks.providerFunds(loanHeader.providerId));
  await acquireAppLock(tx, locks.loan(attemptRow.loanId));

  const attempt = await tx.disbursementAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const loan = await loadLoan(tx, attempt.loanId);

  if (attempt.status === 'SUCCEEDED' && loan.status !== 'PENDING_DISBURSEMENT') {
    return loan; // already confirmed
  }
  if (loan.status !== 'PENDING_DISBURSEMENT' || !['SENT', 'UNKNOWN', 'PENDING'].includes(attempt.status)) {
    throw new ApiError(409, `This disbursement cannot be confirmed (loan ${loan.status}, attempt ${attempt.status}).`);
  }

  const terms = parseTerms(loan.terms);
  const compiled = compileTerms(terms);
  const { state, charges } = openLoan(compiled, businessDay);
  const principal = compiled.principal;

  const journal = await postJournal(tx, {
    providerId: loan.providerId,
    loanId: loan.id,
    businessDay,
    type: 'DISBURSEMENT',
    description: `Disbursement of ${loan.loanNumber}${outcome.reference ? ` (CBS ${outcome.reference})` : ''}`,
    idempotencyKey: `DISBURSEMENT:${loan.id}`,
    createdById: actor.id,
    lines: [
      { account: 'LOANS_RECEIVABLE', debit: principal, memo: 'Principal' },
      { account: 'CASH', credit: principal, memo: 'Paid out' },
      { account: 'FEE_RECEIVABLE', debit: charges.fee, memo: 'Service fee' },
      { account: 'FEE_INCOME', credit: charges.fee },
      { account: 'TAX_RECEIVABLE', debit: charges.taxOnFee, memo: 'Tax on service fee' },
      { account: 'TAX_PAYABLE', credit: charges.taxOnFee },
    ],
  });

  await tx.loanInstallment.createMany({
    data: state.installments.map((i) => ({
      loanId: loan.id,
      number: i.number,
      dueDate: dateFromDay(i.dueDay),
      principalDue: centsToDecimal(i.principalDue),
    })),
  });

  const withInstallments = await loadLoan(tx, loan.id);
  await saveState(tx, withInstallments, null, state, {
    disbursementDate: dateFromDay(businessDay),
    maturityDate: dateFromDay(state.maturityDay),
  });

  await tx.loanProvider.update({
    where: { id: loan.providerId },
    data: { reservedFunds: { decrement: centsToDecimal(principal) } },
  });

  await tx.disbursementAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'SUCCEEDED',
      cbsReference: outcome.reference ?? attempt.cbsReference,
      httpStatus: outcome.httpStatus ?? attempt.httpStatus,
      responseBody: outcome.responseBody?.slice(0, 4000) ?? attempt.responseBody,
      resolvedById: actor.type === 'ADMIN' ? actor.id : null,
      resolutionNote: outcome.note ?? null,
      completedAt: new Date(),
    },
  });

  await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { status: 'DISBURSED' } });

  await audit(tx, actor, 'LOAN_DISBURSED', loan.id, {
    loanNumber: loan.loanNumber,
    journalNo: journal.journalNo,
    reference: outcome.reference,
    fee: centsToDecimal(charges.fee),
    taxOnFee: centsToDecimal(charges.taxOnFee),
  });

  return withInstallments;
}

/** Core banking refused the transfer: release the funds, nothing is owed. */
export async function failDisbursementInTx(
  tx: TxClient,
  attemptId: string,
  outcome: DisbursementOutcome,
  actor: Actor
) {
  const attemptRow = await tx.disbursementAttempt.findUnique({ where: { id: attemptId } });
  if (!attemptRow) throw new ApiError(404, 'Disbursement attempt not found.');
  const loanHeader = await tx.loan.findUniqueOrThrow({
    where: { id: attemptRow.loanId },
    select: { providerId: true },
  });

  await acquireAppLock(tx, locks.providerFunds(loanHeader.providerId));
  await acquireAppLock(tx, locks.loan(attemptRow.loanId));

  const attempt = await tx.disbursementAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const loan = await loadLoan(tx, attempt.loanId);
  if (loan.status !== 'PENDING_DISBURSEMENT' || !['SENT', 'UNKNOWN', 'PENDING'].includes(attempt.status)) {
    throw new ApiError(409, `This disbursement cannot be marked failed (loan ${loan.status}, attempt ${attempt.status}).`);
  }

  await tx.disbursementAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'FAILED',
      cbsReference: outcome.reference ?? attempt.cbsReference,
      httpStatus: outcome.httpStatus ?? attempt.httpStatus,
      responseBody: outcome.responseBody?.slice(0, 4000) ?? attempt.responseBody,
      errorMessage: outcome.errorMessage?.slice(0, 1000) ?? attempt.errorMessage,
      resolvedById: actor.type === 'ADMIN' ? actor.id : null,
      resolutionNote: outcome.note ?? null,
      completedAt: new Date(),
    },
  });
  await tx.loan.update({
    where: { id: loan.id },
    data: { status: 'DISBURSEMENT_FAILED', closedAt: new Date() },
  });
  await tx.loanProvider.update({
    where: { id: loan.providerId },
    data: { reservedFunds: { decrement: loan.principalAmount } },
  });
  await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { status: 'FAILED' } });

  await audit(tx, actor, 'LOAN_DISBURSEMENT_FAILED', loan.id, {
    loanNumber: loan.loanNumber,
    httpStatus: outcome.httpStatus,
    error: outcome.errorMessage,
  });
  return loan;
}

// ----------------------------------------
// Repayments
// ----------------------------------------

export interface RepaymentInput {
  loanId: string;
  amount: Cents;
  channel: 'SUPERAPP' | 'MANUAL' | 'TEST';
  paymentIntentId?: string | null;
  externalReference?: string | null;
  actor: Actor;
  valueDay?: Day;
}

export async function recordRepaymentInTx(tx: TxClient, input: RepaymentInput) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new ApiError(400, 'Repayment amount must be positive.');
  }
  const valueDay = input.valueDay ?? today();

  await acquireAppLock(tx, locks.loan(input.loanId));
  const header = await loadLoan(tx, input.loanId);
  if (header.status !== 'ACTIVE') {
    throw new ApiError(409, `Loan ${header.loanNumber} is ${header.status.toLowerCase().replace(/_/g, ' ')} and cannot take a repayment.`);
  }

  // A teller or bank reference identifies one receipt. Two requests carrying the
  // same one are the same money recorded twice.
  if (input.channel === 'MANUAL' && input.externalReference) {
    const clash = await tx.repayment.findFirst({
      where: {
        channel: 'MANUAL',
        status: 'POSTED',
        externalReference: input.externalReference,
        loan: { providerId: header.providerId },
      },
      select: { receiptNo: true },
    });
    if (clash) {
      throw new ApiError(409, `Reference ${input.externalReference} was already posted as ${clash.receiptNo}.`);
    }
  }

  // Charge everything owed up to the value date first, so the payment settles
  // today's balance rather than yesterday's.
  await accrueLoanInTx(tx, input.loanId, valueDay, input.actor);
  const loan = await loadLoan(tx, input.loanId);
  const before = stateFromRow(loan);

  const { state: after, allocation } = applyPayment(before, input.amount);
  const receiptNo = await nextNumber(tx, 'receipt');

  const journal = await postJournal(tx, {
    providerId: loan.providerId,
    loanId: loan.id,
    businessDay: valueDay,
    type: 'REPAYMENT',
    description: `Repayment ${receiptNo} on ${loan.loanNumber}`,
    idempotencyKey: input.paymentIntentId ? `REPAYMENT:INTENT:${input.paymentIntentId}` : `REPAYMENT:${receiptNo}`,
    createdById: input.actor.id,
    lines: [
      { account: 'CASH', debit: input.amount, memo: `Received via ${input.channel}` },
      { account: 'PENALTY_RECEIVABLE', credit: allocation.penalty },
      { account: 'FEE_RECEIVABLE', credit: allocation.fee },
      { account: 'INTEREST_RECEIVABLE', credit: allocation.interest },
      { account: 'TAX_RECEIVABLE', credit: allocation.tax },
      { account: 'LOANS_RECEIVABLE', credit: allocation.principal },
      { account: 'BORROWER_CREDITS', credit: allocation.excess, memo: 'Overpayment' },
    ],
  });

  const repayment = await tx.repayment.create({
    data: {
      receiptNo,
      loanId: loan.id,
      amount: centsToDecimal(input.amount),
      valueDate: dateFromDay(valueDay),
      channel: input.channel,
      paymentIntentId: input.paymentIntentId ?? null,
      externalReference: input.externalReference ?? null,
      principalPortion: centsToDecimal(allocation.principal),
      interestPortion: centsToDecimal(allocation.interest),
      feePortion: centsToDecimal(allocation.fee),
      penaltyPortion: centsToDecimal(allocation.penalty),
      taxPortion: centsToDecimal(allocation.tax),
      excessPortion: centsToDecimal(allocation.excess),
      allocation: JSON.stringify(allocation.installments),
      journalId: journal.id,
      createdById: input.actor.type === 'ADMIN' ? input.actor.id : null,
    },
  });

  const closing =
    after.status === 'PAID_OFF'
      ? { closedAt: new Date(), repaymentBehavior: repaymentBehavior(after, valueDay) }
      : {};
  await saveState(tx, loan, before, after, closing);
  await refreshNplFlags(loan.borrowerId, tx);

  await audit(tx, input.actor, 'REPAYMENT_POSTED', loan.id, {
    receiptNo,
    loanNumber: loan.loanNumber,
    amount: centsToDecimal(input.amount),
    channel: input.channel,
    allocation: {
      penalty: allocation.penalty,
      fee: allocation.fee,
      interest: allocation.interest,
      tax: allocation.tax,
      principal: allocation.principal,
      excess: allocation.excess,
    },
    paidOff: after.status === 'PAID_OFF',
  });

  return { repayment, allocation, state: after, loan };
}

export async function reverseRepaymentInTx(tx: TxClient, repaymentId: string, reason: string, actor: Actor) {
  const header = await tx.repayment.findUnique({ where: { id: repaymentId }, select: { loanId: true } });
  if (!header) throw new ApiError(404, 'Repayment not found.');

  await acquireAppLock(tx, locks.loan(header.loanId));
  const repayment = await tx.repayment.findUniqueOrThrow({ where: { id: repaymentId } });
  if (repayment.status !== 'POSTED') throw new ApiError(409, 'This repayment has already been reversed.');

  const loan = await loadLoan(tx, repayment.loanId);
  const before = stateFromRow(loan);
  const allocation: PaymentAllocation = {
    amount: toCents(repayment.amount),
    penalty: toCents(repayment.penaltyPortion),
    fee: toCents(repayment.feePortion),
    interest: toCents(repayment.interestPortion),
    tax: toCents(repayment.taxPortion),
    principal: toCents(repayment.principalPortion),
    excess: toCents(repayment.excessPortion),
    installments: JSON.parse(repayment.allocation),
  };

  let after: LoanState;
  try {
    after = reversePayment(before, allocation);
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : 'The repayment cannot be reversed.');
  }

  const businessDay = Math.max(today(), dayFromDate(repayment.valueDate));
  const journal = await reverseJournal(tx, repayment.journalId, {
    businessDay,
    description: `Reversal of ${repayment.receiptNo}: ${reason}`.slice(0, 500),
    createdById: actor.id,
    idempotencyKey: `REVERSAL:REPAYMENT:${repayment.id}`,
  });

  await saveState(tx, loan, before, after, after.status === 'ACTIVE' ? { closedAt: null, repaymentBehavior: null } : {});
  await tx.repayment.update({
    where: { id: repayment.id },
    data: {
      status: 'REVERSED',
      reversedAt: new Date(),
      reversalJournalId: journal.id,
      reversalReason: reason.slice(0, 1000),
    },
  });
  await refreshNplFlags(loan.borrowerId, tx);

  await audit(tx, actor, 'REPAYMENT_REVERSED', loan.id, {
    receiptNo: repayment.receiptNo,
    journalNo: journal.journalNo,
    reason,
  });
  return { repayment, journal };
}

// ----------------------------------------
// Write-off, refunds, capital, tax remittance
// ----------------------------------------

export async function writeOffLoanInTx(tx: TxClient, loanId: string, reason: string, actor: Actor) {
  await acquireAppLock(tx, locks.loan(loanId));
  const header = await loadLoan(tx, loanId);
  if (header.status !== 'ACTIVE') throw new ApiError(409, 'Only an active loan can be written off.');

  const businessDay = today();
  await accrueLoanInTx(tx, loanId, businessDay, actor);
  const loan = await loadLoan(tx, loanId);
  const before = stateFromRow(loan);
  const { state: after, amounts } = writeOff(before);

  const journal = await postJournal(tx, {
    providerId: loan.providerId,
    loanId: loan.id,
    businessDay,
    type: 'WRITE_OFF',
    description: `Write-off of ${loan.loanNumber}: ${reason}`.slice(0, 500),
    idempotencyKey: `WRITE_OFF:${loan.id}`,
    createdById: actor.id,
    lines: [
      { account: 'WRITE_OFF_EXPENSE', debit: amounts.principal, memo: 'Principal written off' },
      { account: 'LOANS_RECEIVABLE', credit: amounts.principal },
      { account: 'INTEREST_INCOME', debit: amounts.interest, memo: 'Unpaid interest reversed' },
      { account: 'INTEREST_RECEIVABLE', credit: amounts.interest },
      { account: 'FEE_INCOME', debit: amounts.fee, memo: 'Unpaid fee reversed' },
      { account: 'FEE_RECEIVABLE', credit: amounts.fee },
      { account: 'PENALTY_INCOME', debit: amounts.penalty, memo: 'Unpaid penalty reversed' },
      { account: 'PENALTY_RECEIVABLE', credit: amounts.penalty },
      { account: 'TAX_PAYABLE', debit: amounts.tax, memo: 'Uncollected tax reversed' },
      { account: 'TAX_RECEIVABLE', credit: amounts.tax },
    ],
  });

  await saveState(tx, loan, before, after, { closedAt: new Date() });
  await refreshNplFlags(loan.borrowerId, tx);
  await audit(tx, actor, 'LOAN_WRITTEN_OFF', loan.id, { loanNumber: loan.loanNumber, journalNo: journal.journalNo, reason, amounts });
  return { journal, amounts };
}

export async function refundCreditInTx(
  tx: TxClient,
  loanId: string,
  amount: Cents,
  reference: string,
  actor: Actor
) {
  await acquireAppLock(tx, locks.loan(loanId));
  const loan = await loadLoan(tx, loanId);
  const credit = toCents(loan.creditBalance);
  if (amount <= 0 || amount > credit) {
    throw new ApiError(409, 'The refund is more than the overpayment held for this loan.');
  }

  const journal = await postJournal(tx, {
    providerId: loan.providerId,
    loanId: loan.id,
    businessDay: today(),
    type: 'REFUND',
    description: `Overpayment refund on ${loan.loanNumber} (${reference})`.slice(0, 500),
    idempotencyKey: `REFUND:${loan.id}:${reference}`,
    createdById: actor.id,
    lines: [
      { account: 'BORROWER_CREDITS', debit: amount },
      { account: 'CASH', credit: amount },
    ],
  });
  if (journal.duplicate) throw new ApiError(409, `Reference ${reference} has already been refunded on this loan.`);
  await tx.loan.update({
    where: { id: loan.id },
    data: { creditBalance: { decrement: centsToDecimal(amount) } },
  });
  await audit(tx, actor, 'OVERPAYMENT_REFUNDED', loan.id, { amount: centsToDecimal(amount), reference, journalNo: journal.journalNo });
  return journal;
}

export async function postCapitalInTx(
  tx: TxClient,
  input: { providerId: string; amount: Cents; direction: 'INJECT' | 'WITHDRAW'; reference: string; note?: string },
  actor: Actor
) {
  if (input.amount <= 0) throw new ApiError(400, 'Amount must be positive.');
  await acquireAppLock(tx, locks.providerFunds(input.providerId));

  if (input.direction === 'WITHDRAW') {
    const funds = await fundPosition(tx, input.providerId);
    if (input.amount > funds.available) {
      throw new ApiError(409, 'The withdrawal is more than the funds not already lent out or reserved.');
    }
  }

  const inject = input.direction === 'INJECT';
  const journal = await postJournal(tx, {
    providerId: input.providerId,
    businessDay: today(),
    type: 'CAPITAL',
    description: `${inject ? 'Capital injection' : 'Capital withdrawal'} ${input.reference}${input.note ? ` — ${input.note}` : ''}`.slice(0, 500),
    idempotencyKey: `CAPITAL:${input.providerId}:${input.reference}`,
    createdById: actor.id,
    lines: inject
      ? [
          { account: 'CASH', debit: input.amount },
          { account: 'CAPITAL', credit: input.amount },
        ]
      : [
          { account: 'CAPITAL', debit: input.amount },
          { account: 'CASH', credit: input.amount },
        ],
  });
  if (journal.duplicate) throw new ApiError(409, `Reference ${input.reference} has already been posted.`);
  await createAuditLogInTx(tx, {
    actorId: actor.id,
    actorName: actor.name ?? undefined,
    actorType: actor.type,
    action: inject ? 'CAPITAL_INJECTED' : 'CAPITAL_WITHDRAWN',
    entity: 'LoanProvider',
    entityId: input.providerId,
    details: { amount: centsToDecimal(input.amount), reference: input.reference, journalNo: journal.journalNo },
  });
  return journal;
}

export async function remitTaxInTx(
  tx: TxClient,
  input: { providerId: string; amount: Cents; reference: string },
  actor: Actor
) {
  if (input.amount <= 0) throw new ApiError(400, 'Amount must be positive.');
  await acquireAppLock(tx, locks.providerFunds(input.providerId));

  const payable = await tx.ledgerAccount.findUnique({
    where: { providerId_systemKey: { providerId: input.providerId, systemKey: 'TAX_PAYABLE' } },
    select: { balance: true },
  });
  if (input.amount > toCents(payable?.balance)) {
    throw new ApiError(409, 'The remittance is more than the tax payable balance.');
  }
  const funds = await fundPosition(tx, input.providerId);
  if (input.amount > funds.available) {
    throw new ApiError(409, 'There are not enough available funds to remit this amount.');
  }

  const journal = await postJournal(tx, {
    providerId: input.providerId,
    businessDay: today(),
    type: 'TAX_REMITTANCE',
    description: `Tax remitted ${input.reference}`.slice(0, 500),
    idempotencyKey: `TAX_REMITTANCE:${input.providerId}:${input.reference}`,
    createdById: actor.id,
    lines: [
      { account: 'TAX_PAYABLE', debit: input.amount },
      { account: 'CASH', credit: input.amount },
    ],
  });
  if (journal.duplicate) throw new ApiError(409, `Reference ${input.reference} has already been remitted.`);
  await createAuditLogInTx(tx, {
    actorId: actor.id,
    actorName: actor.name ?? undefined,
    actorType: actor.type,
    action: 'TAX_REMITTED',
    entity: 'LoanProvider',
    entityId: input.providerId,
    details: { amount: centsToDecimal(input.amount), reference: input.reference, journalNo: journal.journalNo },
  });
  return journal;
}
