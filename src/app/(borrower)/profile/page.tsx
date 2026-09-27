import { Phone, ShieldCheck } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { formatDateTime, toLocalPhone } from '@/lib/format';
import { money } from '@/components/money';
import { borrowerView, profileChecklist } from '@/lib/lending/borrower-documents';
import { ProfileActions } from './profile-actions';
import { ProfileDocuments } from './profile-documents';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Profile' };

function initials(name: string | null, phone: string) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return phone.slice(-2);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export default async function ProfilePage() {
  const { borrower } = await requireBorrowerPage();
  const [accounts, settings, grouped, repaid, documents] = await Promise.all([
    prisma.borrowerAccount.findMany({ where: { borrowerId: borrower.id }, orderBy: { verifiedAt: 'desc' } }),
    getSettings(),
    prisma.loan.groupBy({ by: ['status'], where: { borrowerId: borrower.id }, _count: true }),
    prisma.loan.aggregate({ where: { borrowerId: borrower.id }, _sum: { principalAmount: true } }),
    profileChecklist(borrower.id),
  ]);
  const count = (status: string) => grouped.find((l) => l.status === status)?._count ?? 0;
  const support = String(settings['platform.supportPhone'] || '');
  const currency = String(settings['platform.currency'] || 'ETB');
  const borrowed = Number(repaid._sum.principalAmount ?? 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Profile</h1>

      <section className="ink relative overflow-hidden rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
            {initials(borrower.fullName, borrower.phoneNumber)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold">{borrower.fullName ?? 'Borrower'}</p>
            <p className="num flex items-center gap-1.5 text-sm text-[hsl(var(--ink-muted))]">
              <Phone className="h-3.5 w-3.5" />
              {toLocalPhone(borrower.phoneNumber)}
            </p>
            <p className="mt-0.5 text-[11px] text-[hsl(var(--ink-muted))]">Member since {formatDateTime(borrower.createdAt)}</p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
          {[
            ['Active', String(count('ACTIVE'))],
            ['Repaid', String(count('PAID_OFF'))],
            ['Borrowed', money(borrowed)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-[hsl(var(--ink-raised))] p-2">
              <dt className="text-[11px] text-[hsl(var(--ink-muted))]">{label}</dt>
              <dd className="num mt-0.5 text-sm font-bold">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-center text-[11px] text-[hsl(var(--ink-muted))]">Amounts in {currency}.</p>
      </section>

      <ProfileDocuments items={documents.map(borrowerView)} />

      <ProfileActions accounts={accounts.map((a) => ({ accountNumber: a.accountNumber, accountName: a.accountName }))} />

      <p className="flex items-start gap-2 px-1 text-[11px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Your accounts and your name come from the bank. Nobody can borrow in your name without your phone.
      </p>

      {support && (
        <p className="text-center text-xs text-muted-foreground">
          Need help? Call{' '}
          <a href={`tel:${support}`} className="font-medium text-primary underline">
            {support}
          </a>
          .
        </p>
      )}
    </div>
  );
}
