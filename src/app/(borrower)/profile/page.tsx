import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { formatDateTime } from '@/lib/format';
import { ProfileActions } from './profile-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const { borrower } = await requireBorrowerPage();
  const [accounts, settings, loans] = await Promise.all([
    prisma.borrowerAccount.findMany({ where: { borrowerId: borrower.id }, orderBy: { verifiedAt: 'desc' } }),
    getSettings(),
    prisma.loan.groupBy({ by: ['status'], where: { borrowerId: borrower.id }, _count: true }),
  ]);
  const count = (status: string) => loans.find((l) => l.status === status)?._count ?? 0;
  const support = String(settings['platform.supportPhone'] || '');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Profile</h1>
      <section className="rounded-2xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold">{borrower.fullName ?? 'Borrower'}</p>
        <p className="font-mono text-muted-foreground">{borrower.phoneNumber}</p>
        <p className="mt-1 text-xs text-muted-foreground">Member since {formatDateTime(borrower.createdAt)}</p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-secondary/60 p-2">
            <dt className="text-[11px] text-muted-foreground">Active</dt>
            <dd className="font-semibold">{count('ACTIVE')}</dd>
          </div>
          <div className="rounded-lg bg-secondary/60 p-2">
            <dt className="text-[11px] text-muted-foreground">Repaid</dt>
            <dd className="font-semibold">{count('PAID_OFF')}</dd>
          </div>
          <div className="rounded-lg bg-secondary/60 p-2">
            <dt className="text-[11px] text-muted-foreground">Total</dt>
            <dd className="font-semibold">{loans.reduce((s, l) => s + l._count, 0)}</dd>
          </div>
        </dl>
      </section>
      <ProfileActions accounts={accounts.map((a) => ({ accountNumber: a.accountNumber, accountName: a.accountName }))} />
      {support && <p className="text-center text-xs text-muted-foreground">Need help? Call {support}.</p>}
    </div>
  );
}
