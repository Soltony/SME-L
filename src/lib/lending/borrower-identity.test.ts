import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A borrower's phone number changes; what they owe does not.
 *
 * Loans, applications and repayments hang off `Borrower.id`, so recognising the
 * person is the whole job — and getting it wrong either strands a live loan on
 * a number nobody uses, or hands one person another person's debt.
 */

const db = {
  borrower: { findUnique: vi.fn(), update: vi.fn() },
  borrowerPhone: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), create: vi.fn(), update: vi.fn() },
  borrowerAccount: { findMany: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({ default: db }));
vi.mock('@/lib/audit-log', () => ({ createAuditLogInTx: vi.fn() }));

const OLD = '251911111111';
const NEW = '251922222222';

beforeEach(() => {
  vi.resetModules();
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) (fn as any).mockReset();
  }
  db.borrowerPhone.findMany.mockResolvedValue([]);
});

describe('resolveBorrowerByPhone', () => {
  it('finds a borrower by the number they use now', async () => {
    db.borrower.findUnique.mockResolvedValue({ id: 'b1', phoneNumber: NEW, mergedIntoId: null });
    const { resolveBorrowerByPhone } = await import('./borrower-identity');
    expect((await resolveBorrowerByPhone(NEW))?.id).toBe('b1');
  });

  it('finds them by a number they used before, so a changed SIM is not a new borrower', async () => {
    db.borrower.findUnique.mockResolvedValue(null);
    db.borrowerPhone.findUnique.mockResolvedValue({
      borrowerId: 'b1',
      borrower: { id: 'b1', phoneNumber: NEW, mergedIntoId: null },
    });
    const { resolveBorrowerByPhone } = await import('./borrower-identity');
    expect((await resolveBorrowerByPhone(OLD))?.id).toBe('b1');
  });

  it('follows a merged record to the one that absorbed it', async () => {
    db.borrower.findUnique
      .mockResolvedValueOnce({ id: 'dup', phoneNumber: OLD, mergedIntoId: 'b1' })
      .mockResolvedValueOnce({ id: 'b1', phoneNumber: NEW, mergedIntoId: null });
    const { resolveBorrowerByPhone } = await import('./borrower-identity');
    expect((await resolveBorrowerByPhone(OLD))?.id).toBe('b1');
  });

  it('returns nobody for a number we have never seen', async () => {
    db.borrower.findUnique.mockResolvedValue(null);
    db.borrowerPhone.findUnique.mockResolvedValue(null);
    const { resolveBorrowerByPhone } = await import('./borrower-identity');
    expect(await resolveBorrowerByPhone('251933333333')).toBeNull();
  });
});

describe('adoptPhoneNumber', () => {
  it('moves the borrower onto the new number and keeps the old one on record', async () => {
    db.borrowerPhone.findUnique.mockResolvedValue(null);
    db.borrower.findUnique.mockResolvedValue(null);
    const { adoptPhoneNumber } = await import('./borrower-identity');
    await adoptPhoneNumber(db as any, 'b1', NEW, 'APPROVAL');

    expect(db.borrowerPhone.updateMany).toHaveBeenCalledWith({ where: { borrowerId: 'b1' }, data: { isCurrent: false } });
    expect(db.borrowerPhone.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneNumber: NEW } })
    );
    expect(db.borrower.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { phoneNumber: NEW } });
  });

  it('refuses a number that belongs to somebody else', async () => {
    db.borrowerPhone.findUnique.mockResolvedValue({ borrowerId: 'someone-else' });
    const { adoptPhoneNumber } = await import('./borrower-identity');
    await expect(adoptPhoneNumber(db as any, 'b1', NEW, 'APPROVAL')).rejects.toThrow(/another borrower/);
    expect(db.borrower.update).not.toHaveBeenCalled();
  });
});

describe('borrowersHoldingAccounts', () => {
  it('only counts accounts core banking confirmed', async () => {
    db.borrowerAccount.findMany.mockResolvedValue([{ borrowerId: 'b1' }]);
    const { borrowersHoldingAccounts } = await import('./borrower-identity');
    await borrowersHoldingAccounts(db as any, ['1000123456']);
    // A simulated account answers for any number at all, so it is no evidence
    // that two phone numbers belong to the same person.
    expect(db.borrowerAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'CBS' }) })
    );
  });

  it('asks nothing when there are no accounts to match', async () => {
    const { borrowersHoldingAccounts } = await import('./borrower-identity');
    expect(await borrowersHoldingAccounts(db as any, [])).toEqual([]);
    expect(db.borrowerAccount.findMany).not.toHaveBeenCalled();
  });
});

describe('borrowerPhoneNumbers', () => {
  it('lists every number, so uploaded scoring data keyed to an old one is still found', async () => {
    db.borrowerPhone.findMany.mockResolvedValue([{ phoneNumber: OLD }, { phoneNumber: NEW }]);
    const { borrowerPhoneNumbers } = await import('./borrower-identity');
    expect((await borrowerPhoneNumbers(db as any, { id: 'b1', phoneNumber: NEW })).sort()).toEqual([OLD, NEW].sort());
  });
});

describe('mergeBorrowers', () => {
  function mergeTx(source: Record<string, unknown>, target: Record<string, unknown>) {
    return {
      borrower: {
        findUnique: vi.fn(async ({ where }: any) => (where.id === 'dup' ? source : target)),
        update: vi.fn(),
      },
      loan: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      loanApplication: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      paymentIntent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      termsAcceptance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      borrowerAccount: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn(), delete: vi.fn() },
      borrowerPhone: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };
  }

  const base = { status: 'ACTIVE', isNpl: false, nplSince: null, fullName: null, firstSeenAt: new Date('2026-01-01'), mergedIntoId: null };

  it('moves everything onto the surviving record and keeps the duplicate resolvable', async () => {
    const tx = mergeTx({ ...base, id: 'dup', phoneNumber: OLD }, { ...base, id: 'b1', phoneNumber: NEW });
    const { mergeBorrowers } = await import('./borrower-identity');
    const result = await mergeBorrowers(tx as any, 'dup', 'b1', { id: 'admin', type: 'ADMIN' });

    expect(result.movedLoans).toBe(2);
    expect(tx.loan.updateMany).toHaveBeenCalledWith({ where: { borrowerId: 'dup' }, data: { borrowerId: 'b1' } });
    expect(tx.borrowerPhone.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { borrowerId: 'dup' } })
    );
    // Kept, not deleted: receipts and audit entries still name it.
    expect(tx.borrower.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dup' },
        data: expect.objectContaining({ status: 'MERGED', mergedIntoId: 'b1' }),
      })
    );
  });

  it('carries a restriction across, so merging is never a way to shed one', async () => {
    const tx = mergeTx(
      { ...base, id: 'dup', phoneNumber: OLD, isNpl: true, nplSince: new Date('2026-02-02') },
      { ...base, id: 'b1', phoneNumber: NEW }
    );
    const { mergeBorrowers } = await import('./borrower-identity');
    await mergeBorrowers(tx as any, 'dup', 'b1', { id: 'admin', type: 'ADMIN' });

    expect(tx.borrower.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1' }, data: expect.objectContaining({ isNpl: true }) })
    );
  });

  it('carries a block across too', async () => {
    const tx = mergeTx({ ...base, id: 'dup', phoneNumber: OLD, status: 'BLOCKED' }, { ...base, id: 'b1', phoneNumber: NEW });
    const { mergeBorrowers } = await import('./borrower-identity');
    await mergeBorrowers(tx as any, 'dup', 'b1', { id: 'admin', type: 'ADMIN' });

    expect(tx.borrower.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1' }, data: expect.objectContaining({ status: 'BLOCKED' }) })
    );
  });

  it('refuses to merge a record into itself', async () => {
    const tx = mergeTx({ ...base, id: 'b1', phoneNumber: NEW }, { ...base, id: 'b1', phoneNumber: NEW });
    const { mergeBorrowers } = await import('./borrower-identity');
    await expect(mergeBorrowers(tx as any, 'b1', 'b1', { id: 'admin', type: 'ADMIN' })).rejects.toThrow(/same borrower/);
  });

  it('refuses to merge a record twice', async () => {
    const tx = mergeTx({ ...base, id: 'dup', phoneNumber: OLD, mergedIntoId: 'other' }, { ...base, id: 'b1', phoneNumber: NEW });
    const { mergeBorrowers } = await import('./borrower-identity');
    await expect(mergeBorrowers(tx as any, 'dup', 'b1', { id: 'admin', type: 'ADMIN' })).rejects.toThrow(/already been merged/);
  });
});
