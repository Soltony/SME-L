import Link from 'next/link';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { canDecide, CHANGE_HANDLERS } from '@/lib/approvals';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { Pager } from '@/components/admin/data-shell';
import { ChangeDecision } from '@/components/admin/change-decision';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

const TABS = [
  { key: 'PENDING', label: 'Waiting' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Withdrawn' },
];

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const status = TABS.some((t) => t.key === params.status) ? params.status! : 'PENDING';
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 20;
  const where = { status, ...(user.providerId ? { providerId: user.providerId } : {}) };

  const [changes, total] = await Promise.all([
    prisma.pendingChange.findMany({
      where,
      include: { createdBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.pendingChange.count({ where }),
  ]);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Maker–checker queue. Nothing here takes effect until someone other than the requester approves it; approving applies the change immediately, in one transaction."
      />

      <nav className="mb-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/admin/approvals?status=${tab.key}`}
            className={cn(
              'rounded-full border px-3 py-1 text-sm font-medium',
              tab.key === status ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {changes.length === 0 ? (
        <div className="panel p-10 text-center text-sm text-muted-foreground">No requests here.</div>
      ) : (
        <div className="space-y-3">
          {changes.map((change) => {
            const kind = `${change.entityType}.${change.action}`;
            const label = (CHANGE_HANDLERS as Record<string, { label: string }>)[kind]?.label ?? kind;
            const payload = JSON.parse(change.payload) as Record<string, unknown>;
            const previous = change.previousData ? (JSON.parse(change.previousData) as Record<string, unknown>) : null;
            const changed = new Set<string>(change.changedFields ? JSON.parse(change.changedFields) : Object.keys(payload));
            const keys = Object.keys(payload).filter((k) => !previous || changed.has(k));
            return (
              <article key={change.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                    <h2 className="mt-0.5 font-semibold">{change.summary}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Requested by {change.createdBy.fullName} · {formatDateTime(change.createdAt)}
                      {change.decidedBy && ` · decided by ${change.decidedBy.fullName} ${formatDateTime(change.decidedAt)}`}
                    </p>
                    {change.comment && <p className="mt-1 text-sm">“{change.comment}”</p>}
                  </div>
                  <StatusBadge status={change.status} />
                </div>

                <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-secondary/50 text-left text-xs">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Field</th>
                        {previous && <th className="px-3 py-2 font-semibold">Current</th>}
                        <th className="px-3 py-2 font-semibold">{previous ? 'Proposed' : 'Value'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {keys.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-muted-foreground">
                            No field differs from the current record.
                          </td>
                        </tr>
                      )}
                      {keys.map((key) => (
                        <tr key={key} className="align-top">
                          <td className="px-3 py-2 font-medium">{key}</td>
                          {previous && (
                            <td className="px-3 py-2 text-muted-foreground">
                              <pre className="whitespace-pre-wrap break-words font-sans text-xs">{pretty(previous[key])}</pre>
                            </td>
                          )}
                          <td className="px-3 py-2">
                            <pre className="whitespace-pre-wrap break-words font-sans text-xs">{pretty(payload[key])}</pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {change.status === 'PENDING' && (
                  <div className="mt-3 border-t border-border pt-3">
                    <ChangeDecision changeId={change.id} canDecide={canDecide(user, kind)} isOwn={change.createdById === user.id} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <div className="panel mt-3">
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/approvals" params={{ status }} />
      </div>
    </>
  );
}
