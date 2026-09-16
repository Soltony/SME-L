import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { formatAmount } from '@/lib/money';
import { formatDay, dayFromDate } from '@/lib/business-date';
import { getSettings } from '@/lib/settings';
import { notifyBorrower } from '@/lib/notifications';
import { sendDisbursement } from '@/lib/integrations/core-banking';
import { ApiError } from '@/lib/errors';
import type { TxClient } from '@/lib/db-lock';
import {
  confirmDisbursementInTx,
  failDisbursementInTx,
  SYSTEM_ACTOR,
  type Actor,
} from './loan-service';

export type DisbursementRunStatus = 'QUEUED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';

/**
 * Sends a loan's pending disbursement to core banking and books the result.
 *
 * Runs on the server straight after the loan is created, and again from the
 * maintenance tick for anything still queued. The borrower's browser has no
 * part in it: the previous flow relied on the mini-app calling a second
 * endpoint, so a closed webview left a booked, interest-bearing loan that was
 * never paid out.
 *
 * The attempt is claimed PENDING → SENT atomically before the call, so two
 * workers can never send the same loan twice.
 */
export async function executeDisbursement(loanId: string, actor: Actor = SYSTEM_ACTOR): Promise<DisbursementRunStatus> {
  const settings = await getSettings(true);
  if (!settings['lending.disbursementsEnabled']) return 'QUEUED';

  const attempt = await prisma.disbursementAttempt.findFirst({
    where: { loanId, status: 'PENDING' },
    orderBy: { attemptNo: 'desc' },
    include: {
      loan: {
        select: {
          loanNumber: true,
          status: true,
          principalAmount: true,
          borrower: { select: { phoneNumber: true } },
        },
      },
    },
  });
  if (!attempt || attempt.loan.status !== 'PENDING_DISBURSEMENT') return 'SKIPPED';

  const claim = await prisma.disbursementAttempt.updateMany({
    where: { id: attempt.id, status: 'PENDING' },
    data: { status: 'SENT' },
  });
  if (claim.count !== 1) return 'SKIPPED';

  const result = await sendDisbursement({
    requestId: attempt.requestId,
    creditAccount: attempt.creditAccount,
    amount: attempt.amount.toString(),
    providerCode: attempt.providerCode,
    loanNumber: attempt.loan.loanNumber,
  });

  await createAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorType: 'EXTERNAL',
    action: `CBS_DISBURSEMENT_${result.outcome}`,
    entity: 'Loan',
    entityId: loanId,
    details: {
      loanNumber: attempt.loan.loanNumber,
      requestId: attempt.requestId,
      httpStatus: result.httpStatus,
      reference: result.reference,
      error: result.errorMessage,
    },
  });

  const outcome = {
    reference: result.reference,
    httpStatus: result.httpStatus,
    responseBody: result.responseBody,
    errorMessage: result.errorMessage,
  };

  if (result.outcome === 'SUCCEEDED') {
    try {
      const loan = await prisma.$transaction((tx) => confirmDisbursementInTx(tx, attempt.id, outcome, actor));
      const firstDue = [...loan.installments].sort((a, b) => a.number - b.number)[0];
      void notifyBorrower({
        phone: attempt.loan.borrower.phoneNumber,
        template: 'LOAN_DISBURSED',
        vars: {
          amount: formatAmount(attempt.amount, String(settings['platform.currency'] || 'ETB')),
          account: attempt.creditAccount,
          loanNumber: attempt.loan.loanNumber,
          dueDate: firstDue ? formatDay(dayFromDate(firstDue.dueDate)) : '',
        },
        entity: 'Loan',
        entityId: loanId,
      });
      return 'SUCCEEDED';
    } catch (error) {
      // The money has left core banking but could not be booked. That must
      // not be retried automatically or forgotten: park it for an operator
      // with the bank's reference attached.
      console.error('[disbursement] confirmed by CBS but booking failed', loanId, error);
      await prisma.disbursementAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'UNKNOWN',
          cbsReference: result.reference,
          httpStatus: result.httpStatus,
          responseBody: result.responseBody,
          errorMessage: `Core banking confirmed the transfer but it could not be booked: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 1000),
        },
      });
      return 'UNKNOWN';
    }
  }

  if (result.outcome === 'FAILED') {
    await prisma.$transaction((tx) => failDisbursementInTx(tx, attempt.id, outcome, actor));
    void notifyBorrower({
      phone: attempt.loan.borrower.phoneNumber,
      template: 'DISBURSEMENT_FAILED',
      vars: { loanNumber: attempt.loan.loanNumber, account: attempt.creditAccount },
      entity: 'Loan',
      entityId: loanId,
    });
    return 'FAILED';
  }

  await prisma.disbursementAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'UNKNOWN',
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
    },
  });
  return 'UNKNOWN';
}

/** A request stuck in SENT this long was interrupted mid-call; its outcome is unknown. */
const STALE_SENT_MS = 10 * 60_000;

export async function processDisbursementQueue(limit = 50) {
  const stale = await prisma.disbursementAttempt.updateMany({
    where: { status: 'SENT', updatedAt: { lt: new Date(Date.now() - STALE_SENT_MS) } },
    data: {
      status: 'UNKNOWN',
      errorMessage: 'The request was interrupted before core banking answered. Check the transfer before resolving.',
    },
  });

  const settings = await getSettings(true);
  if (!settings['lending.disbursementsEnabled']) {
    return { markedUnknown: stale.count, attempted: 0, results: {} as Record<string, number>, paused: true };
  }

  const queued = await prisma.disbursementAttempt.findMany({
    where: { status: 'PENDING', loan: { status: 'PENDING_DISBURSEMENT' } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { loanId: true },
  });

  const results: Record<string, number> = {};
  for (const { loanId } of queued) {
    const status = await executeDisbursement(loanId);
    results[status] = (results[status] ?? 0) + 1;
  }
  return { markedUnknown: stale.count, attempted: queued.length, results, paused: false };
}

/**
 * An operator's decision on a disbursement whose outcome core banking left in
 * doubt, taken after checking the transfer in core banking. Runs through
 * maker-checker, so it is applied by `approvals.ts`.
 */
export async function resolveDisbursementInTx(
  tx: TxClient,
  attemptId: string,
  resolution: 'CONFIRM' | 'FAIL',
  input: { reference?: string | null; note: string },
  actor: Actor
) {
  const attempt = await tx.disbursementAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new ApiError(404, 'Disbursement attempt not found.');
  if (!['UNKNOWN', 'SENT'].includes(attempt.status)) {
    throw new ApiError(409, `Only an attempt with an unknown outcome can be resolved (this one is ${attempt.status}).`);
  }
  const outcome = { reference: input.reference ?? attempt.cbsReference, note: input.note };
  return resolution === 'CONFIRM'
    ? confirmDisbursementInTx(tx, attemptId, outcome, actor)
    : failDisbursementInTx(tx, attemptId, { ...outcome, errorMessage: `Resolved as failed: ${input.note}` }, actor);
}
