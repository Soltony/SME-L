import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { createAuditLogInTx } from '@/lib/audit-log';
import { acquireAppLock, locks, type TxClient } from '@/lib/db-lock';
import type { Actor } from './loan-service';

/**
 * Recognising a borrower who comes back on a different phone number.
 *
 * The super app identifies a borrower by phone number, and that is the only
 * identity it gives us. But people change SIM cards, and a loan does not end
 * because a number did. Look a borrower up by their current number alone and a
 * returning borrower arrives as a stranger: a second record is created, their
 * live loan is invisible and unpayable on it, their repayment history counts
 * for nothing, and an overdue flag on the old record restricts nobody.
 *
 * Every loan, application, repayment and intent here hangs off the immutable
 * `Borrower.id`, never off the number. So nothing has to be rewritten when a
 * number changes — the record simply takes the new number and keeps the old one
 * in `BorrowerPhone`. That is the difference between this and rekeying a
 * borrower's history onto a new primary key, which cannot be done safely while
 * money is outstanding against it.
 *
 * A returning borrower is recognised two ways:
 *
 *  1. their new number is already in `BorrowerPhone` (staff linked it), or
 *  2. core banking says the new number holds an account we had already verified
 *     for exactly one borrower.
 *
 * (2) is evidence, not proof — an account can have more than one holder — so it
 * applies only when exactly one borrower matches, only on accounts the bank
 * itself confirmed, and it is written to the audit log every time. Operators
 * can switch it off and link by approval instead.
 */

export type PhoneLinkSource = 'REGISTRATION' | 'ACCOUNT_MATCH' | 'APPROVAL';

export interface BorrowerIdentity {
  id: string;
  phoneNumber: string;
  status: string;
  isNpl: boolean;
}

/**
 * The borrower this number belongs to — whether it is the number they use now
 * or one they used before — following a merge to the surviving record.
 */
export async function resolveBorrowerByPhone(phoneNumber: string, client: TxClient = prisma) {
  const direct = await client.borrower.findUnique({ where: { phoneNumber } });
  if (direct) return followMerge(direct, client);

  const known = await client.borrowerPhone.findUnique({
    where: { phoneNumber },
    include: { borrower: true },
  });
  if (!known) return null;
  return followMerge(known.borrower, client);
}

type BorrowerRow = Awaited<ReturnType<typeof prisma.borrower.findUnique>>;

/** A merged record forwards to the one that absorbed it. */
async function followMerge(borrower: NonNullable<BorrowerRow>, client: TxClient) {
  let current = borrower;
  // Chains are one deep in practice; the bound stops a cycle from hanging a
  // sign-in if one is ever written by hand.
  for (let hops = 0; current.mergedIntoId && hops < 5; hops += 1) {
    const next = await client.borrower.findUnique({ where: { id: current.mergedIntoId } });
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Every number this borrower has used, current one first.
 *
 * Uploaded scoring data is keyed by phone number rather than by borrower, so a
 * borrower who changed number would lose the data a provider uploaded for them
 * — and with it their score — unless it is looked up against all of them.
 */
export async function borrowerPhoneNumbers(
  client: TxClient,
  borrower: { id: string; phoneNumber: string }
): Promise<string[]> {
  const rows = await client.borrowerPhone.findMany({
    where: { borrowerId: borrower.id },
    select: { phoneNumber: true },
  });
  const numbers = new Set<string>([borrower.phoneNumber]);
  for (const row of rows) numbers.add(row.phoneNumber);
  return Array.from(numbers);
}

/**
 * Records a number against a borrower and makes it the one they sign in with.
 * The number they used before stays in `BorrowerPhone`, so their old sessions,
 * receipts and support tickets still lead back to them.
 */
export async function adoptPhoneNumber(
  tx: TxClient,
  borrowerId: string,
  phoneNumber: string,
  linkedBy: PhoneLinkSource
) {
  const owner = await tx.borrowerPhone.findUnique({
    where: { phoneNumber },
    select: { borrowerId: true },
  });
  if (owner && owner.borrowerId !== borrowerId) {
    throw new ApiError(409, 'That phone number already belongs to another borrower.');
  }

  const clash = await tx.borrower.findUnique({ where: { phoneNumber }, select: { id: true } });
  if (clash && clash.id !== borrowerId) {
    throw new ApiError(409, 'That phone number already belongs to another borrower.');
  }

  await tx.borrowerPhone.updateMany({ where: { borrowerId }, data: { isCurrent: false } });
  await tx.borrowerPhone.upsert({
    where: { phoneNumber },
    create: { borrowerId, phoneNumber, isCurrent: true, linkedBy },
    update: { borrowerId, isCurrent: true, linkedBy },
  });
  await tx.borrower.update({ where: { id: borrowerId }, data: { phoneNumber } });
}

/** Ensures a borrower's current number is in their phone history. */
export async function ensureCurrentPhoneRecorded(
  tx: TxClient,
  borrowerId: string,
  phoneNumber: string,
  linkedBy: PhoneLinkSource = 'REGISTRATION'
) {
  const existing = await tx.borrowerPhone.findUnique({ where: { phoneNumber } });
  if (existing?.borrowerId === borrowerId) {
    if (!existing.isCurrent) {
      await tx.borrowerPhone.updateMany({ where: { borrowerId }, data: { isCurrent: false } });
      await tx.borrowerPhone.update({ where: { phoneNumber }, data: { isCurrent: true } });
    }
    return;
  }
  if (existing) throw new ApiError(409, 'That phone number already belongs to another borrower.');
  await tx.borrowerPhone.create({ data: { borrowerId, phoneNumber, isCurrent: true, linkedBy } });
}

/**
 * Borrowers who already hold one of these account numbers, as confirmed by core
 * banking. Simulated accounts are never evidence of anything.
 */
export async function borrowersHoldingAccounts(
  client: TxClient,
  accountNumbers: string[],
  options: { includeSimulated?: boolean } = {}
): Promise<string[]> {
  if (accountNumbers.length === 0) return [];
  const rows = await client.borrowerAccount.findMany({
    where: {
      accountNumber: { in: accountNumbers },
      ...(options.includeSimulated ? {} : { source: 'CBS' }),
    },
    select: { borrowerId: true },
    distinct: ['borrowerId'],
  });
  return rows.map((r) => r.borrowerId);
}

export interface MergeResult {
  movedLoans: number;
  movedApplications: number;
  movedIntents: number;
  movedAccounts: number;
  movedAcceptances: number;
}

/**
 * Folds a duplicate record into the borrower it was always the same person as.
 *
 * Everything keyed by borrower id is re-pointed at the surviving record and the
 * duplicate is kept, marked MERGED, pointing at its successor: deleting it
 * would strand any receipt or audit entry that names it. A restriction on
 * either record survives the merge — a merge must never be a way to shed one.
 */
export async function mergeBorrowers(
  tx: TxClient,
  sourceId: string,
  targetId: string,
  actor: Actor
): Promise<MergeResult> {
  if (sourceId === targetId) throw new ApiError(400, 'That is the same borrower.');

  const [source, target] = await Promise.all([
    tx.borrower.findUnique({ where: { id: sourceId } }),
    tx.borrower.findUnique({ where: { id: targetId } }),
  ]);
  if (!source) throw new ApiError(404, 'Borrower not found.');
  if (!target) throw new ApiError(404, 'Borrower not found.');
  if (source.mergedIntoId) throw new ApiError(409, 'That borrower has already been merged.');

  const [movedLoans, movedApplications, movedIntents, movedAcceptances] = await Promise.all([
    tx.loan.updateMany({ where: { borrowerId: sourceId }, data: { borrowerId: targetId } }),
    tx.loanApplication.updateMany({ where: { borrowerId: sourceId }, data: { borrowerId: targetId } }),
    tx.paymentIntent.updateMany({ where: { borrowerId: sourceId }, data: { borrowerId: targetId } }),
    tx.termsAcceptance.updateMany({ where: { borrowerId: sourceId }, data: { borrowerId: targetId } }),
  ]);

  // Accounts carry a (borrower, account) uniqueness, so move only the ones the
  // survivor does not already hold and drop the rest.
  const sourceAccounts = await tx.borrowerAccount.findMany({ where: { borrowerId: sourceId } });
  const targetAccounts = await tx.borrowerAccount.findMany({
    where: { borrowerId: targetId },
    select: { accountNumber: true },
  });
  const held = new Set(targetAccounts.map((a) => a.accountNumber));
  let movedAccounts = 0;
  for (const account of sourceAccounts) {
    if (held.has(account.accountNumber)) {
      await tx.borrowerAccount.delete({ where: { id: account.id } });
      continue;
    }
    await tx.borrowerAccount.update({ where: { id: account.id }, data: { borrowerId: targetId } });
    movedAccounts += 1;
  }

  // Every number either record has used now leads to the survivor.
  await tx.borrowerPhone.updateMany({
    where: { borrowerId: sourceId },
    data: { borrowerId: targetId, isCurrent: false },
  });

  const restricted = source.isNpl || target.isNpl;
  const blocked = source.status === 'BLOCKED' || target.status === 'BLOCKED';
  await tx.borrower.update({
    where: { id: targetId },
    data: {
      isNpl: restricted,
      nplSince: restricted ? (target.nplSince ?? source.nplSince ?? new Date()) : null,
      status: blocked ? 'BLOCKED' : target.status,
      fullName: target.fullName ?? source.fullName,
      firstSeenAt: source.firstSeenAt < target.firstSeenAt ? source.firstSeenAt : target.firstSeenAt,
    },
  });

  // Keep the absorbed row resolvable, and free its number so the survivor can
  // take it. The unique column cannot hold the same value twice.
  await tx.borrower.update({
    where: { id: sourceId },
    data: {
      status: 'MERGED',
      mergedIntoId: targetId,
      phoneNumber: `merged:${sourceId}`,
      isNpl: false,
      nplSince: null,
    },
  });

  await createAuditLogInTx(tx, {
    actorId: actor.id,
    actorName: actor.name,
    actorType: actor.type,
    action: 'BORROWER_MERGED',
    entity: 'Borrower',
    entityId: targetId,
    details: {
      mergedFrom: sourceId,
      mergedFromPhone: source.phoneNumber,
      intoPhone: target.phoneNumber,
      movedLoans: movedLoans.count,
      movedApplications: movedApplications.count,
      restrictionCarried: restricted,
    },
  });

  return {
    movedLoans: movedLoans.count,
    movedApplications: movedApplications.count,
    movedIntents: movedIntents.count,
    movedAccounts,
    movedAcceptances: movedAcceptances.count,
  };
}

/**
 * Moves a borrower onto a new number, absorbing any record that number already
 * created for them. Used by the approved phone change and by account matching.
 */
export async function linkPhoneToBorrower(
  tx: TxClient,
  borrowerId: string,
  newPhoneNumber: string,
  linkedBy: PhoneLinkSource,
  actor: Actor
) {
  await acquireAppLock(tx, locks.borrower(borrowerId));

  const target = await tx.borrower.findUnique({ where: { id: borrowerId } });
  if (!target) throw new ApiError(404, 'Borrower not found.');
  if (target.mergedIntoId) throw new ApiError(409, 'That borrower has already been merged into another record.');

  const occupant = await resolveBorrowerByPhone(newPhoneNumber, tx);
  let merge: MergeResult | null = null;

  if (occupant && occupant.id !== borrowerId) {
    await acquireAppLock(tx, locks.borrower(occupant.id));
    // The borrower already used the app on the new number, so a second record
    // exists. Fold it in rather than leaving two records for one person.
    merge = await mergeBorrowers(tx, occupant.id, borrowerId, actor);
  }

  await adoptPhoneNumber(tx, borrowerId, newPhoneNumber, linkedBy);
  return { merge };
}
