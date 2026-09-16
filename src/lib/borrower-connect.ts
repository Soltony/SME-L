import prisma from './prisma';
import { createAuditLog } from './audit-log';
import { createBorrowerSession } from './session';
import { normalizePhone, isValidEthiopianPhone } from './format';
import { PaymentError, unwrapSuperAppToken, validateSuperAppToken } from './integrations/payment-gateway';
import { ApiError } from './errors';
import { fetchCustomerAccounts } from './integrations/core-banking';
import { getSettings } from './settings';
import {
  borrowersHoldingAccounts,
  ensureCurrentPhoneRecorded,
  linkPhoneToBorrower,
  resolveBorrowerByPhone,
} from './lending/borrower-identity';

/**
 * Exchanges a super-app token for a borrower session. The super app is the
 * identity provider: its token resolves to a phone number, and that phone
 * number is the borrower. A first-time phone is registered automatically.
 *
 * Every connect gets a borrower session — never a staff one. The previous
 * system looked the phone number up among staff accounts and, on a match,
 * opened a full admin session with no password.
 */
export async function connectBorrower(
  rawToken: string,
  meta: { ipAddress?: string | null; userAgent?: string | null }
) {
  const bare = unwrapSuperAppToken(rawToken.replace(/^Bearer\s+/i, ''));
  if (!bare) throw new ApiError(400, 'Super app token is missing.');

  let phone: string;
  try {
    ({ phone } = await validateSuperAppToken(`Bearer ${bare}`));
  } catch (error) {
    if (error instanceof PaymentError) throw new ApiError(error.status, error.message);
    throw error;
  }

  const phoneNumber = normalizePhone(phone);
  if (!isValidEthiopianPhone(phoneNumber)) {
    throw new ApiError(401, 'Your super app account does not have a usable phone number.');
  }

  return openBorrowerSession(phoneNumber, { superAppToken: bare, isTest: false, ...meta });
}

export async function openBorrowerSession(
  phoneNumber: string,
  input: { superAppToken: string; isTest: boolean; fullName?: string | null; ipAddress?: string | null; userAgent?: string | null }
) {
  // Resolve through every number this borrower has used, not just the one on
  // their record: a borrower who changed SIM is the same borrower, and looking
  // only at the current number would register them again and strand the loan
  // they still owe on the old one.
  const existing = await resolveBorrowerByPhone(phoneNumber);

  // An unknown number may still be a borrower we know. Ask core banking whose
  // accounts it holds before treating them as new.
  const recognised = existing ? null : await recogniseByBankAccount(phoneNumber, input);

  const borrower = existing
    ? await prisma.borrower.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
    : recognised
      ? await prisma.borrower.update({ where: { id: recognised.id }, data: { lastSeenAt: new Date() } })
      : await registerBorrower(phoneNumber, input.fullName || null);

  if (borrower.status === 'BLOCKED') {
    throw new ApiError(403, 'This account is blocked. Please contact support.');
  }

  await createBorrowerSession({
    borrowerId: borrower.id,
    phone: borrower.phoneNumber,
    superAppToken: input.superAppToken,
    isTest: input.isTest || undefined,
  });

  await createAuditLog({
    actorId: borrower.phoneNumber,
    actorType: 'BORROWER',
    action: input.isTest
      ? 'BORROWER_TEST_SESSION_STARTED'
      : existing || recognised
        ? 'BORROWER_SESSION_STARTED'
        : 'BORROWER_REGISTERED',
    entity: 'Borrower',
    entityId: borrower.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { borrowerId: borrower.id, isNew: !existing && !recognised, isTest: input.isTest };
}

/** A borrower nobody has seen before, with their first number on record. */
async function registerBorrower(phoneNumber: string, fullName: string | null) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.borrower.create({ data: { phoneNumber, fullName } });
    await ensureCurrentPhoneRecorded(tx, created.id, phoneNumber, 'REGISTRATION');
    return created;
  });
}

/**
 * Recognises a returning borrower whose number has changed, by asking core
 * banking which accounts the new number holds and looking for a borrower we
 * already verified one of those accounts for.
 *
 * Deliberately conservative, because an account can have more than one holder
 * and a wrong match would hand somebody another person's loans:
 *
 *  - only accounts core banking confirmed count, never simulated ones;
 *  - exactly one candidate borrower, otherwise it is left to staff;
 *  - a bank that cannot be reached means "not recognised", never "new";
 *  - every link is written to the audit log with the account that caused it.
 *
 * Operators who would rather link only through maker-checker can turn this off
 * with the `lending.linkPhoneByVerifiedAccount` setting.
 */
async function recogniseByBankAccount(
  phoneNumber: string,
  input: { isTest: boolean; ipAddress?: string | null; userAgent?: string | null }
) {
  const settings = await getSettings().catch(() => null);
  if (settings && !settings['lending.linkPhoneByVerifiedAccount']) return null;

  let lookup;
  try {
    lookup = await fetchCustomerAccounts(phoneNumber);
  } catch (error) {
    // The bank is the only witness we have. Without it we cannot claim this
    // number belongs to an existing borrower, so treat them as new.
    console.error('[connect] account lookup failed while recognising a new number', error);
    return null;
  }

  // A simulated lookup answers for any number at all, so it proves nothing.
  if (lookup.simulated) return null;

  const numbers = lookup.accounts.map((a) => a.accountNumber).filter(Boolean);
  const candidates = await borrowersHoldingAccounts(prisma, numbers);
  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      console.warn('[connect] several borrowers hold the accounts of this number; leaving it to staff');
    }
    return null;
  }

  const borrower = await prisma.borrower.findUnique({ where: { id: candidates[0] } });
  if (!borrower || borrower.mergedIntoId) return null;

  const previousPhone = borrower.phoneNumber;
  const matched = await prisma.borrowerAccount.findFirst({
    where: { borrowerId: borrower.id, accountNumber: { in: numbers }, source: 'CBS' },
    select: { accountNumber: true },
  });

  try {
    await prisma.$transaction((tx) =>
      linkPhoneToBorrower(tx, borrower.id, phoneNumber, 'ACCOUNT_MATCH', {
        id: 'SYSTEM',
        name: 'Super app sign-in',
        type: 'SYSTEM',
      })
    );
  } catch (error) {
    console.error('[connect] could not link the new number to the borrower', error);
    return null;
  }

  await createAuditLog({
    actorId: phoneNumber,
    actorType: 'SYSTEM',
    action: 'BORROWER_PHONE_LINKED',
    entity: 'Borrower',
    entityId: borrower.id,
    details: {
      previousPhone,
      newPhone: phoneNumber,
      matchedOnAccount: matched?.accountNumber ?? null,
      basis: 'CBS verified account',
    },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return prisma.borrower.findUnique({ where: { id: borrower.id } });
}
