import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { titleCase } from '@/lib/format';
import { containsMarkup } from '@/lib/plain-text';
import type { CbsAccount } from '@/lib/integrations/core-banking';

/**
 * What core banking says about a borrower: the accounts their phone number
 * holds, and — from those accounts — their name.
 *
 * The super app identifies a borrower by phone number only, so the account
 * holder name on their bank record is the first real name we have for them.
 * It is taken at sign-in, and again whenever the borrower refreshes their
 * accounts, and shown to them and to staff in place of a bare phone number.
 */

export interface AccountLookup {
  accounts: CbsAccount[];
  simulated: boolean;
}

const MAX_NAME_LENGTH = 100;

/**
 * The account holder's name across the accounts, or null when the bank gave
 * none usable. The name on most accounts wins — a borrower with a personal and
 * a business account is named as the person — and ties go to the first
 * account. A name the bank keeps in capitals is shown in normal case.
 */
export function holderName(accounts: { accountName: string | null }[]): string | null {
  const tally = new Map<string, { name: string; count: number }>();
  for (const account of accounts) {
    const name = String(account.accountName ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (!name || !/\p{L}/u.test(name) || containsMarkup(name)) continue;
    const key = name.toLowerCase();
    const entry = tally.get(key) ?? { name, count: 0 };
    entry.count += 1;
    tally.set(key, entry);
  }
  let best: { name: string; count: number } | null = null;
  for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry;
  if (!best) return null;
  return /[A-Z]/.test(best.name) && best.name === best.name.toUpperCase() ? titleCase(best.name) : best.name;
}

/**
 * Stores a lookup: the borrower's verified accounts become exactly the ones the
 * bank returned, and their name is taken from those accounts.
 *
 * The bank's name replaces whatever was there, since it is the verified one. A
 * simulated lookup only fills a missing name, so a name typed at test sign-in
 * is kept.
 */
export async function applyAccountLookup(
  borrower: { id: string; phoneNumber: string; fullName: string | null },
  lookup: AccountLookup,
  context: { reason: 'SIGN_IN' | 'BORROWER_REFRESH'; ipAddress?: string | null; userAgent?: string | null }
): Promise<{ fullName: string | null }> {
  const numbers = lookup.accounts.map((a) => a.accountNumber);
  const source = lookup.simulated ? 'SIMULATED' : 'CBS';
  const name = holderName(lookup.accounts);
  const rename = name !== null && name !== borrower.fullName && (!borrower.fullName || !lookup.simulated);

  await prisma.$transaction([
    prisma.borrowerAccount.deleteMany({
      where: { borrowerId: borrower.id, accountNumber: { notIn: numbers.length ? numbers : ['__none__'] } },
    }),
    ...lookup.accounts.map((a) =>
      prisma.borrowerAccount.upsert({
        where: { borrowerId_accountNumber: { borrowerId: borrower.id, accountNumber: a.accountNumber } },
        create: { borrowerId: borrower.id, accountNumber: a.accountNumber, accountName: a.accountName, source },
        update: { accountName: a.accountName, verifiedAt: new Date(), source },
      })
    ),
    ...(rename ? [prisma.borrower.update({ where: { id: borrower.id }, data: { fullName: name } })] : []),
  ]);

  await createAuditLog({
    actorId: borrower.phoneNumber,
    actorType: 'BORROWER',
    action: 'BORROWER_ACCOUNTS_REFRESHED',
    entity: 'Borrower',
    entityId: borrower.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    details: {
      count: numbers.length,
      simulated: lookup.simulated,
      reason: context.reason,
      ...(rename ? { nameFromBank: name, previousName: borrower.fullName } : {}),
    },
  });

  return { fullName: rename ? name : borrower.fullName };
}
