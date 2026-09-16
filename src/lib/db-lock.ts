import { Prisma } from '@prisma/client';

/**
 * Serialising a read-then-write against SQL Server.
 *
 * Every money movement here is "read the balance, decide, write": is there
 * enough in the provider's fund, is this borrower still under their limit,
 * what does this loan owe right now. Left unguarded, two concurrent requests
 * both read the same balance and both write — the previous system could pay
 * out two loans against funds that covered one, and apply one callback twice.
 *
 * `sp_getapplock` is held by the transaction, taken on a name rather than on
 * rows, and lives in the database, so it still serialises when the app runs as
 * several instances. SQL Server releases it at commit or rollback.
 *
 * Lock order is fixed to rule out deadlocks: borrower → provider funds → loan.
 * Any code that needs more than one takes them in that order.
 */

export type TxClient = Prisma.TransactionClient;

const DEFAULT_TIMEOUT_MS = 10_000;

export class AppLockError extends Error {
  resource: string;
  code: number;
  constructor(resource: string, code: number) {
    super(`Could not acquire lock ${resource} (sp_getapplock returned ${code}).`);
    this.name = 'AppLockError';
    this.resource = resource;
    this.code = code;
  }
}

export const locks = {
  borrower: (borrowerId: string) => `sme:borrower:${borrowerId}`,
  providerFunds: (providerId: string) => `sme:funds:${providerId}`,
  loan: (loanId: string) => `sme:loan:${loanId}`,
  change: (changeId: string) => `sme:change:${changeId}`,
};

/**
 * Takes an exclusive application lock for the life of `tx`. Return codes: 0
 * granted, 1 granted after waiting, negative is a refusal — timeout, deadlock
 * victim or bad parameter — and the caller must fail rather than carry on
 * unserialised.
 */
export async function acquireAppLock(
  tx: TxClient,
  resource: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const rows = await tx.$queryRaw<{ rc: number }[]>`
    DECLARE @rc int;
    EXEC @rc = sp_getapplock
      @Resource = ${resource},
      @LockMode = 'Exclusive',
      @LockOwner = 'Transaction',
      @LockTimeout = ${timeoutMs};
    SELECT @rc AS rc;`;

  const code = rows[0]?.rc ?? -999;
  if (code < 0) throw new AppLockError(resource, code);
}
