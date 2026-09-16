import prisma from './prisma';
import { createAuditLog } from './audit-log';
import { createBorrowerSession } from './session';
import { normalizePhone, isValidEthiopianPhone } from './format';
import { PaymentError, unwrapSuperAppToken, validateSuperAppToken } from './integrations/payment-gateway';
import { ApiError } from './errors';

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
  const existing = await prisma.borrower.findUnique({ where: { phoneNumber } });
  const borrower = existing
    ? await prisma.borrower.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
    : await prisma.borrower.create({ data: { phoneNumber, fullName: input.fullName || null } });

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
      : existing
        ? 'BORROWER_SESSION_STARTED'
        : 'BORROWER_REGISTERED',
    entity: 'Borrower',
    entityId: borrower.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { borrowerId: borrower.id, isNew: !existing, isTest: input.isTest };
}
