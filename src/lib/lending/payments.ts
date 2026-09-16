import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { acquireAppLock, locks, type TxClient } from '@/lib/db-lock';
import { createAuditLog, createAuditLogInTx } from '@/lib/audit-log';
import { centsToDecimal, formatMoney, toCents, type Cents } from '@/lib/money';
import { today } from '@/lib/business-date';
import { uuid } from '@/lib/jwt';
import { getSettings } from '@/lib/settings';
import { notifyBorrower } from '@/lib/notifications';
import { postJournal } from '@/lib/accounting/ledger';
import {
  callbackStrictMode,
  gatewayTimestamp,
  initiateWalletPayment,
  PaymentError,
  resolveGatewayConfig,
  unwrapSuperAppToken,
  validateSuperAppToken,
  verifyCallbackSignature,
} from '@/lib/integrations/payment-gateway';
import { accrue, totalOutstanding } from './engine';
import { compileTerms, parseTerms } from './terms';
import { stateFromRow } from './loan-store';
import { recordRepaymentInTx, type Actor } from './loan-service';

/** What a loan owes if settled today — accrued in memory, nothing written. */
export async function payoffQuote(loanId: string) {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { installments: true } });
  if (!loan || loan.status !== 'ACTIVE') return null;
  const state = stateFromRow(loan);
  const projected = accrue(state, compileTerms(parseTerms(loan.terms)), Math.max(today(), state.accruedThrough)).state;
  return { loan, state: projected, payoff: totalOutstanding(projected) };
}

export interface StartRepaymentResult {
  transactionId: string;
  status: 'PENDING' | 'COMPLETED';
  paymentToken: string | null;
  receiptNo: string | null;
}

/**
 * Starts a wallet repayment for a borrower's own loan.
 *
 * The amount is capped at today's payoff. The previous flow accepted any amount
 * and only noticed an overpayment when the callback arrived — after the wallet
 * had been charged — and then discarded the payment as "failed", keeping the
 * money with nothing recorded against the borrower.
 */
export async function startWalletRepayment(input: {
  borrower: { id: string; phoneNumber: string };
  superAppToken: string;
  isTest: boolean;
  loanId: string;
  amount: Cents;
}): Promise<StartRepaymentResult> {
  const quote = await payoffQuote(input.loanId);
  if (!quote || quote.loan.borrowerId !== input.borrower.id) throw new ApiError(404, 'Loan not found.');
  if (input.amount < 100) throw new ApiError(400, 'The minimum repayment is 1.00.', 'amount');
  if (input.amount > quote.payoff) {
    throw new ApiError(400, `The most you can pay today is ${formatMoney(quote.payoff)}.`, 'amount');
  }

  const settings = await getSettings();
  const timeoutMinutes = Number(settings['payments.pendingTimeoutMinutes']) || 30;
  const inFlight = await prisma.paymentIntent.findFirst({
    where: {
      loanId: input.loanId,
      status: 'PENDING',
      createdAt: { gt: new Date(Date.now() - timeoutMinutes * 60_000) },
    },
    select: { id: true },
  });
  if (inFlight) {
    throw new ApiError(409, 'A payment for this loan is already waiting for confirmation. Please wait a moment.');
  }

  const transactionId = uuid();
  const transactionTime = gatewayTimestamp();
  const actor: Actor = { id: input.borrower.phoneNumber, type: 'BORROWER' };

  if (input.isTest) {
    // A test session has no wallet. The repayment is applied directly and
    // labelled TEST, so it is exercised end to end and never mistaken for
    // real money in reports.
    const { receiptNo } = await prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.create({
        data: {
          transactionId,
          loanId: input.loanId,
          borrowerId: input.borrower.id,
          amount: centsToDecimal(input.amount),
          channel: 'TEST',
          status: 'COMPLETED',
          transactionTime,
          completedAt: new Date(),
        },
      });
      const posted = await recordRepaymentInTx(tx, {
        loanId: input.loanId,
        amount: input.amount,
        channel: 'TEST',
        paymentIntentId: intent.id,
        actor,
      });
      return { receiptNo: posted.repayment.receiptNo };
    });
    void notifyRepayment(input.loanId, receiptNo);
    return { transactionId, status: 'COMPLETED', paymentToken: null, receiptNo };
  }

  // Repayments are collected into the lending provider's own account.
  const provider = await prisma.loanProvider.findUnique({
    where: { id: quote.loan.providerId },
    select: { collectionAccountNo: true },
  });
  const { config, missing } = resolveGatewayConfig(provider?.collectionAccountNo);
  if (!config) {
    console.error('[payment] gateway not configured; missing', missing.join(', '));
    throw new ApiError(503, 'Wallet repayments are not available right now.');
  }

  const intent = await prisma.paymentIntent.create({
    data: {
      transactionId,
      loanId: input.loanId,
      borrowerId: input.borrower.id,
      amount: centsToDecimal(input.amount),
      channel: 'SUPERAPP',
      status: 'PENDING',
      transactionTime,
      collectionAccountNo: config.accountNo,
    },
  });

  try {
    const { paymentToken } = await initiateWalletPayment({
      config,
      transactionId,
      transactionTime,
      amount: centsToDecimal(input.amount),
      superAppToken: input.superAppToken,
    });
    await createAuditLog({
      actorId: actor.id,
      actorType: 'BORROWER',
      action: 'REPAYMENT_INITIATED',
      entity: 'Loan',
      entityId: input.loanId,
      details: { transactionId, amount: centsToDecimal(input.amount), collectionAccountNo: config.accountNo },
    });
    return { transactionId, status: 'PENDING', paymentToken, receiptNo: null };
  } catch (error) {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'FAILED',
        failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      },
    });
    if (error instanceof PaymentError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

async function notifyRepayment(loanId: string, receiptNo: string) {
  const repayment = await prisma.repayment.findUnique({
    where: { receiptNo },
    include: {
      loan: {
        select: {
          loanNumber: true,
          status: true,
          principalOutstanding: true,
          interestOutstanding: true,
          feeOutstanding: true,
          penaltyOutstanding: true,
          taxOutstanding: true,
          borrower: { select: { phoneNumber: true } },
        },
      },
    },
  });
  if (!repayment) return;
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');
  const loan = repayment.loan;
  if (loan.status === 'PAID_OFF') {
    await notifyBorrower({
      phone: loan.borrower.phoneNumber,
      template: 'LOAN_PAID_OFF',
      vars: { loanNumber: loan.loanNumber },
      entity: 'Loan',
      entityId: loanId,
    });
    return;
  }
  const balance =
    toCents(loan.principalOutstanding) +
    toCents(loan.interestOutstanding) +
    toCents(loan.feeOutstanding) +
    toCents(loan.penaltyOutstanding) +
    toCents(loan.taxOutstanding);
  await notifyBorrower({
    phone: loan.borrower.phoneNumber,
    template: 'REPAYMENT_RECEIVED',
    vars: {
      amount: formatMoney(toCents(repayment.amount), currency),
      loanNumber: loan.loanNumber,
      receiptNo,
      balance: formatMoney(balance, currency),
    },
    entity: 'Loan',
    entityId: loanId,
  });
}

/**
 * Money that arrived for a loan that can no longer take it (repaid by another
 * payment moments earlier, or written off). It is booked as an overpayment the
 * borrower can be refunded, never dropped.
 */
async function holdAsCreditInTx(tx: TxClient, loanId: string, amount: Cents, reference: string, actor: Actor) {
  await acquireAppLock(tx, locks.loan(loanId));
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  const journal = await postJournal(tx, {
    providerId: loan.providerId,
    loanId,
    businessDay: today(),
    type: 'REPAYMENT',
    description: `Unapplied payment ${reference} held for ${loan.loanNumber}`,
    idempotencyKey: `UNAPPLIED:${reference}`,
    createdById: actor.id,
    lines: [
      { account: 'CASH', debit: amount },
      { account: 'BORROWER_CREDITS', credit: amount, memo: 'Held for refund' },
    ],
  });
  await tx.loan.update({ where: { id: loanId }, data: { creditBalance: { increment: centsToDecimal(amount) } } });
  await createAuditLogInTx(tx, {
    actorId: actor.id,
    actorType: actor.type,
    action: 'PAYMENT_HELD_AS_CREDIT',
    entity: 'Loan',
    entityId: loanId,
    details: { reference, amount: centsToDecimal(amount), journalNo: journal.journalNo, loanStatus: loan.status },
  });
}

function redact(body: Record<string, unknown>) {
  const copy: Record<string, unknown> = { ...body };
  for (const key of ['token', 'Signature', 'signature']) if (key in copy) copy[key] = '***';
  return JSON.stringify(copy).slice(0, 8000);
}

export interface CallbackResult {
  httpStatus: number;
  message: string;
}

/**
 * Applies a gateway callback. In order: a valid bearer token, a known
 * transaction, a verified signature, a matching amount — and then the intent is
 * claimed inside the same transaction that posts the repayment, so a replayed
 * or concurrent callback applies it exactly once.
 */
export async function processGatewayCallback(
  body: Record<string, unknown>,
  authorization: string | null,
  meta: { ipAddress?: string | null }
): Promise<CallbackResult> {
  const bearer = unwrapSuperAppToken(authorization?.replace(/^Bearer\s+/i, ''));
  if (!bearer) return { httpStatus: 401, message: 'Authorization header is missing.' };
  try {
    await validateSuperAppToken(`Bearer ${bearer}`);
  } catch (error) {
    await createAuditLog({
      actorId: 'GATEWAY',
      actorType: 'EXTERNAL',
      action: 'PAYMENT_CALLBACK_REJECTED',
      ipAddress: meta.ipAddress,
      details: { reason: 'token validation failed', detail: error instanceof Error ? error.message : String(error) },
    });
    return { httpStatus: 401, message: 'Authentication failed.' };
  }

  const txnRef = typeof body.txnRef === 'string' ? body.txnRef : typeof body.transactionId === 'string' ? body.transactionId : '';
  if (!txnRef) return { httpStatus: 400, message: 'txnRef is required.' };

  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId: txnRef },
    include: { borrower: { select: { phoneNumber: true } } },
  });
  // Same answer for unknown and already-applied, so the endpoint cannot be used
  // to probe which references exist.
  if (!intent || !['PENDING', 'EXPIRED'].includes(intent.status) || intent.channel !== 'SUPERAPP') {
    return { httpStatus: 200, message: 'Transaction reference not found or already processed.' };
  }

  // Verify against the account this payment was signed for, not whatever the
  // provider's collection account is now — it may have changed in between.
  const { config, missing } = resolveGatewayConfig(intent.collectionAccountNo);
  const strict = callbackStrictMode();
  if (!config) {
    console.error('[payment-callback] cannot verify signature; missing', missing.join(', '));
    if (strict) return { httpStatus: 503, message: 'Payment verification is not available.' };
  } else {
    const check = verifyCallbackSignature(body, config, {
      transactionId: intent.transactionId,
      transactionTime: intent.transactionTime,
    });
    if (!check.valid) {
      await createAuditLog({
        actorId: 'GATEWAY',
        actorType: 'EXTERNAL',
        action: strict ? 'PAYMENT_CALLBACK_REJECTED' : 'PAYMENT_CALLBACK_SIGNATURE_MISMATCH',
        entity: 'Loan',
        entityId: intent.loanId,
        ipAddress: meta.ipAddress,
        details: { txnRef, strict, signaturePresent: Boolean(body.Signature ?? body.signature) },
      });
      if (strict) return { httpStatus: 401, message: 'Invalid signature.' };
    }
  }

  const expected = toCents(intent.amount);
  const reported = body.paidAmount ?? body.amount;
  if (reported !== undefined && reported !== null && String(reported).trim() !== '') {
    let reportedCents: Cents | null = null;
    try {
      reportedCents = toCents(String(reported));
    } catch {
      reportedCents = null;
    }
    if (reportedCents !== expected) {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: { in: ['PENDING', 'EXPIRED'] } },
        data: { status: 'FAILED', failureReason: `Gateway reported ${String(reported)}, expected ${centsToDecimal(expected)}.` },
      });
      await createAuditLog({
        actorId: 'GATEWAY',
        actorType: 'EXTERNAL',
        action: 'PAYMENT_CALLBACK_AMOUNT_MISMATCH',
        entity: 'Loan',
        entityId: intent.loanId,
        ipAddress: meta.ipAddress,
        details: { txnRef, reported: String(reported), expected: centsToDecimal(expected) },
      });
      return { httpStatus: 200, message: 'Paid amount does not match; the payment was not applied.' };
    }
  }

  const status = String(body.status ?? body.Status ?? '').toUpperCase();
  if (status && /FAIL|CANCEL|REJECT|DECLIN/.test(status)) {
    await prisma.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ['PENDING', 'EXPIRED'] } },
      data: { status: 'FAILED', failureReason: `Gateway status ${status}`, callbackPayload: redact(body) },
    });
    return { httpStatus: 200, message: 'Failure recorded.' };
  }

  const actor: Actor = { id: 'GATEWAY', name: 'Payment gateway', type: 'EXTERNAL' };
  const gatewayReference = body.transactionId && body.transactionId !== txnRef ? String(body.transactionId) : null;

  let receiptNo: string | null = null;
  try {
    receiptNo = await prisma.$transaction(async (tx) => {
      const claim = await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: { in: ['PENDING', 'EXPIRED'] } },
        data: { status: 'COMPLETED', completedAt: new Date(), gatewayReference, callbackPayload: redact(body) },
      });
      if (claim.count !== 1) return null;

      try {
        const posted = await recordRepaymentInTx(tx, {
          loanId: intent.loanId,
          amount: expected,
          channel: 'SUPERAPP',
          paymentIntentId: intent.id,
          externalReference: gatewayReference,
          actor,
        });
        return posted.repayment.receiptNo;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await holdAsCreditInTx(tx, intent.loanId, expected, intent.transactionId, actor);
          return null;
        }
        throw error;
      }
    });
  } catch (error) {
    // Rolled back: the intent is still claimable, so the gateway's retry will
    // apply it. The detail stays in the log.
    console.error('[payment-callback] processing failed', txnRef, error);
    return { httpStatus: 500, message: 'The payment could not be applied right now.' };
  }

  if (receiptNo) void notifyRepayment(intent.loanId, receiptNo);
  return { httpStatus: 200, message: 'Payment confirmed.' };
}

/** Wallet payments nobody confirmed within the timeout. A late callback is still honoured. */
export async function expireStalePaymentIntents() {
  const settings = await getSettings();
  const timeoutMinutes = Number(settings['payments.pendingTimeoutMinutes']) || 30;
  const result = await prisma.paymentIntent.updateMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - timeoutMinutes * 60_000) } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
