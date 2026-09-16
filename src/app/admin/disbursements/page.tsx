import Link from 'next/link';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { toCents } from '@/lib/money';
import { formatDateTime, maskAccount } from '@/lib/format';
import { DISBURSEMENT_STATUSES } from '@/lib/types';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge, statusLabel } from '@/components/admin/status-badge';
import { ActionDialog, ConfirmButton } from '@/components/admin/action-dialog';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Disbursements' };

export default async function DisbursementsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const status = (DISBURSEMENT_STATUSES as readonly string[]).includes(params.status ?? '') ? params.status! : undefined;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');
  const scope = user.providerId ? { loan: { providerId: user.providerId } } : {};
  const where = { ...scope, ...(status ? { status } : {}) };

  const [attempts, total, counts] = await Promise.all([
    prisma.disbursementAttempt.findMany({
      where,
      include: {
        loan: { select: { id: true, loanNumber: true, status: true, borrower: { select: { fullName: true, phoneNumber: true } }, provider: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.disbursementAttempt.count({ where }),
    prisma.disbursementAttempt.groupBy({ by: ['status'], where: scope, _count: true }),
  ]);
  const countOf = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const canUpdate = hasPermission(user, 'disbursements', 'update');

  return (
    <>
      <PageHeader
        title="Disbursements"
        description="Every attempt to pay a loan out through core banking. A loan goes on the books only when core banking confirms; an attempt whose outcome is unknown must be checked in core banking and resolved here."
        actions={
          canUpdate && !user.providerId ? (
            <ConfirmButton
              label="Process queue now"
              confirm="Send every queued disbursement to core banking now?"
              endpoint="/api/admin/disbursements"
              body={{ action: 'process-queue' }}
            />
          ) : null
        }
      />

      {!settings['lending.disbursementsEnabled'] && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">
          Disbursements are switched off in Settings. Approved loans are queued and nothing is sent to core banking.
        </div>
      )}

      <nav className="mb-4 flex flex-wrap gap-2">
        {[undefined, ...DISBURSEMENT_STATUSES].map((s) => (
          <Link
            key={s ?? 'all'}
            href={s ? `/admin/disbursements?status=${s}` : '/admin/disbursements'}
            className={cn(
              'rounded-full border px-3 py-1 text-sm font-medium',
              s === status ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
            )}
          >
            {s ? `${statusLabel(s)} (${countOf(s)})` : 'All'}
          </Link>
        ))}
      </nav>

      <TableCard>
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Requested</th>
              <th className="px-4 py-2.5 font-semibold">Loan</th>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 font-semibold">Account</th>
              <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">CBS reference / detail</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {attempts.length === 0 && <EmptyRow colSpan={8} message="Nothing here." />}
            {attempts.map((a) => (
              <tr key={a.id} className="align-top hover:bg-secondary/30">
                <td className="px-4 py-2.5 text-xs">{formatDateTime(a.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/admin/loans/${a.loan.id}`} className="font-mono text-primary hover:underline">
                    {a.loan.loanNumber}
                  </Link>
                  {!user.providerId && <p className="text-xs text-muted-foreground">{a.loan.provider.name}</p>}
                </td>
                <td className="px-4 py-2.5">
                  {a.loan.borrower.fullName ?? '—'}
                  <p className="font-mono text-xs text-muted-foreground">{a.loan.borrower.phoneNumber}</p>
                </td>
                <td className="px-4 py-2.5 font-mono">{maskAccount(a.creditAccount)}</td>
                <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(a.amount), currency)}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={a.status} />
                </td>
                <td className="max-w-[280px] px-4 py-2.5 text-xs">
                  {a.cbsReference && <p className="font-mono">{a.cbsReference}</p>}
                  <p className="text-muted-foreground">{a.errorMessage ?? a.resolutionNote ?? (a.httpStatus ? `HTTP ${a.httpStatus}` : '')}</p>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {canUpdate && a.status === 'UNKNOWN' && (
                    <ActionDialog
                      label="Resolve"
                      title={`Resolve ${a.loan.loanNumber}`}
                      description="Check the transfer in core banking first. Confirm books the loan from today; failed releases the funds and nothing is owed. Needs approval."
                      endpoint="/api/admin/disbursements"
                      extra={{ action: 'resolve', attemptId: a.id }}
                      submitLabel="Send for approval"
                      fields={[
                        {
                          name: 'resolution',
                          label: 'What core banking shows',
                          type: 'select',
                          required: true,
                          options: [
                            { value: 'CONFIRM', label: 'The money reached the borrower' },
                            { value: 'FAIL', label: 'No money was sent' },
                          ],
                        },
                        { name: 'reference', label: 'Core banking reference', help: 'Required when confirming.', defaultValue: a.cbsReference ?? '' },
                        { name: 'note', label: 'How you checked', type: 'textarea', required: true },
                      ]}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/disbursements" params={{ status }} />
      </TableCard>
    </>
  );
}
