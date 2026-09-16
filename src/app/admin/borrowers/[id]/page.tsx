import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { toCents } from '@/lib/money';
import { formatDateTime, maskAccount } from '@/lib/format';
import { buildLoanView } from '@/lib/lending/loan-view';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { ActionDialog } from '@/components/admin/action-dialog';
import { money, moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Borrower' };

export default async function BorrowerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const scope = user.providerId ? { providerId: user.providerId } : {};

  const borrower = await prisma.borrower.findUnique({
    where: { id },
    include: {
      accounts: { orderBy: { verifiedAt: 'desc' } },
      loans: {
        where: scope,
        include: { installments: true, product: { select: { name: true } }, provider: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      },
      applications: {
        where: scope,
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
  if (!borrower) notFound();
  if (user.providerId && borrower.applications.length === 0) notFound();

  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const dataRows = await prisma.borrowerDataRow.findMany({
    where: { borrowerKey: borrower.phoneNumber, ...(user.providerId ? { config: { providerId: user.providerId } } : {}) },
    include: { config: { select: { name: true, provider: { select: { name: true } } } } },
  });
  const loans = borrower.loans.map((l) => buildLoanView(l));
  const canBlock = hasPermission(user, 'borrowers', 'update') && !user.providerId;

  return (
    <>
      <PageHeader
        title={borrower.fullName ?? borrower.phoneNumber}
        breadcrumbs={[{ label: 'Borrowers', href: '/admin/borrowers' }, { label: borrower.phoneNumber }]}
        description={`Registered ${formatDateTime(borrower.createdAt)} · last seen ${formatDateTime(borrower.lastSeenAt)}`}
        actions={
          <>
            <StatusBadge status={borrower.status} />
            {borrower.isNpl && <StatusBadge status="NPL" />}
            {canBlock &&
              (borrower.status === 'ACTIVE' ? (
                <ActionDialog
                  label="Block"
                  destructive
                  title="Block borrower"
                  description="Stops sign-in and new applications. Existing loans keep running and can still be repaid."
                  endpoint={`/api/admin/borrowers/${borrower.id}`}
                  method="PATCH"
                  extra={{ status: 'BLOCKED' }}
                  submitLabel="Block"
                  fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
                />
              ) : (
                <ActionDialog
                  label="Unblock"
                  title="Unblock borrower"
                  endpoint={`/api/admin/borrowers/${borrower.id}`}
                  method="PATCH"
                  extra={{ status: 'ACTIVE' }}
                  submitLabel="Unblock"
                  fields={[{ name: 'reason', label: 'Reason', type: 'textarea' }]}
                />
              ))}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 text-sm">
          <h2 className="mb-2 font-semibold">Verified accounts</h2>
          {borrower.accounts.length === 0 ? (
            <p className="text-muted-foreground">None yet — loaded from core banking when the borrower applies.</p>
          ) : (
            <ul className="space-y-1.5">
              {borrower.accounts.map((a) => (
                <li key={a.id} className="flex justify-between gap-2">
                  <span className="font-mono">{maskAccount(a.accountNumber)}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.accountName ?? ''} {a.source === 'SIMULATED' && '(simulated)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel p-4 text-sm lg:col-span-2">
          <h2 className="mb-2 font-semibold">Provisioned data</h2>
          {dataRows.length === 0 ? (
            <p className="text-muted-foreground">No uploaded data for this borrower.</p>
          ) : (
            dataRows.map((row) => (
              <div key={row.id} className="mb-3">
                <p className="text-xs font-semibold text-muted-foreground">
                  {row.config.name} · {row.config.provider.name} · updated {formatDateTime(row.updatedAt)}
                </p>
                <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                  {Object.entries(JSON.parse(row.data) as Record<string, unknown>).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))
          )}
        </section>
      </div>

      <h2 className="mb-2 mt-6 font-semibold">Loans</h2>
      <TableCard>
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">Loan</th>
              <th className="px-4 py-2 font-semibold">Product</th>
              <th className="px-4 py-2 text-right font-semibold">Principal</th>
              <th className="px-4 py-2 text-right font-semibold">Owed today</th>
              <th className="px-4 py-2 text-right font-semibold">DPD</th>
              <th className="px-4 py-2 font-semibold">Behaviour</th>
              <th className="px-4 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loans.length === 0 && <EmptyRow colSpan={7} message="No loans." />}
            {loans.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2">
                  <Link href={`/admin/loans/${l.id}`} className="font-mono text-primary hover:underline">
                    {l.loanNumber}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  {l.productName}
                  <p className="text-xs text-muted-foreground">{l.providerName}</p>
                </td>
                <td className="num px-4 py-2 text-right">{money(l.principal, currency)}</td>
                <td className="num px-4 py-2 text-right">{money(l.outstanding.total, currency)}</td>
                <td className="num px-4 py-2 text-right">{l.daysPastDue}</td>
                <td className="px-4 py-2 text-xs">{l.repaymentBehavior ?? '—'}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={l.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <h2 className="mb-2 mt-6 font-semibold">Applications</h2>
      <TableCard>
        <table className="w-full min-w-[640px] text-sm">
          <tbody className="divide-y divide-border">
            {borrower.applications.length === 0 && <EmptyRow colSpan={5} message="No applications." />}
            {borrower.applications.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2">
                  <Link href={`/admin/applications/${a.id}`} className="font-mono text-primary hover:underline">
                    {a.applicationNo}
                  </Link>
                </td>
                <td className="px-4 py-2">{a.product.name}</td>
                <td className="num px-4 py-2 text-right">{moneyCents(toCents(a.requestedAmount), currency)}</td>
                <td className="px-4 py-2 text-xs">{formatDateTime(a.createdAt)}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
