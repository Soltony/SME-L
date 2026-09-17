import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { canDecide } from '@/lib/approvals';
import { summarizeChange } from '@/lib/approval-view';
import { formatDateTime, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyRow, Pager, TableCard } from '@/components/admin/data-shell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

const TABS = [
  { key: 'PENDING', label: 'Waiting' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Withdrawn' },
];

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const status = TABS.some((t) => t.key === params.status) ? params.status! : 'PENDING';
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 20;
  const scope = user.providerId ? { providerId: user.providerId } : {};
  const where = { status, ...scope };

  const [changes, total, counts] = await Promise.all([
    prisma.pendingChange.findMany({
      where,
      include: { createdBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
      // Oldest first while waiting, so nothing sits at the bottom of the queue.
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.pendingChange.count({ where }),
    prisma.pendingChange.groupBy({ by: ['status'], where: scope, _count: true }),
  ]);
  const rows = await Promise.all(changes.map(async (change) => ({ change, summary: await summarizeChange(change) })));
  const countOf = (key: string) => counts.find((c) => c.status === key)?._count ?? 0;
  const pending = status === 'PENDING';

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Maker–checker queue. Nothing takes effect until someone other than the requester reviews and approves it; approving applies the change at once, in one transaction."
      />

      <nav className="mb-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/admin/approvals?status=${tab.key}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium',
              tab.key === status ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
            )}
          >
            {tab.label}
            <span className={cn('rounded-full px-1.5 text-xs', tab.key === status ? 'bg-primary-foreground/20' : 'bg-secondary')}>{countOf(tab.key)}</span>
          </Link>
        ))}
      </nav>

      <TableCard>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Request</th>
              <th className="px-4 py-2.5 font-semibold">Provider</th>
              <th className="px-4 py-2.5 font-semibold">Requested by</th>
              <th className="px-4 py-2.5 font-semibold">{pending ? 'Waiting since' : 'Decided'}</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && <EmptyRow colSpan={6} message={pending ? 'Nothing is waiting for approval.' : 'No requests here.'} />}
            {rows.map(({ change, summary }) => {
              const own = change.createdById === user.id;
              const actionable = pending && !own && canDecide(user, summary.kind);
              return (
                <tr key={change.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/approvals/${change.id}`} className="font-medium text-primary hover:underline">
                      {summary.label}
                    </Link>
                    {summary.subject && (
                      <p className="text-xs text-muted-foreground">
                        {summary.subject.label} · {summary.subject.name}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">{summary.provider ?? <span className="text-muted-foreground">Platform-wide</span>}</td>
                  <td className="px-4 py-2.5">
                    {summary.requestedBy}
                    {own && <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">You</span>}
                  </td>
                  <td className="px-4 py-2.5" title={formatDateTime(pending ? summary.requestedAt : summary.decidedAt)}>
                    {pending ? (
                      timeAgo(summary.requestedAt)
                    ) : (
                      <>
                        {summary.decidedAt ? timeAgo(summary.decidedAt) : '—'}
                        {summary.decidedBy && <span className="block text-xs text-muted-foreground">by {summary.decidedBy}</span>}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={change.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild size="sm" variant={actionable ? 'default' : 'outline'}>
                      <Link href={`/admin/approvals/${change.id}`}>
                        {actionable ? 'Review' : 'View'}
                        <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>
      <div className="panel mt-3">
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/approvals" params={{ status }} />
      </div>
    </>
  );
}
