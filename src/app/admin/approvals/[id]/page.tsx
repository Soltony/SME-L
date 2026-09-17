import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { canDecide } from '@/lib/approvals';
import { buildChangeView } from '@/lib/approval-view';
import { formatDateTime, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { ChangeDecision } from '@/components/admin/change-decision';
import { ChangeValue } from '@/components/admin/change-value';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review request' };

const OUTCOME: Record<string, string> = {
  APPROVED: 'Approved and applied',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn by the requester',
  FAILED: 'Approved, but could not be applied',
};

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const change = await prisma.pendingChange.findUnique({
    where: { id },
    include: { createdBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
  });
  if (!change || (user.providerId && change.providerId !== user.providerId)) notFound();

  const view = await buildChangeView(change);
  const pending = change.status === 'PENDING';
  const changed = view.rows.filter((r) => r.changed);
  const unchanged = view.rows.filter((r) => !r.changed);
  const compare = view.comparedWith !== null;
  const beforeLabel = view.comparedWith === 'NOW' ? 'Now' : 'Before';

  const rowsTable = (rows: typeof view.rows) => (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-secondary/50 text-left text-xs">
          <tr>
            <th className="w-44 px-3 py-2 font-semibold">Field</th>
            {compare && <th className="px-3 py-2 font-semibold">{beforeLabel}</th>}
            <th className="px-3 py-2 font-semibold">{compare ? 'Proposed' : 'Value'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.label} className="align-top">
              <td className="px-3 py-2.5 font-medium">{row.label}</td>
              {compare && (
                <td className="px-3 py-2.5 text-muted-foreground">
                  {row.before ? <ChangeValue value={row.before} /> : <span>—</span>}
                </td>
              )}
              <td className={`px-3 py-2.5 ${row.changed && compare ? 'bg-primary/5' : ''}`}>
                <ChangeValue value={row.after} emphasis={row.changed && compare} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader
        title={view.label}
        breadcrumbs={[{ label: 'Approvals', href: `/admin/approvals?status=${change.status}` }, { label: view.label }]}
        description={view.sentence}
        actions={<StatusBadge status={change.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <section className="panel p-4 text-sm">
            <h2 className="mb-3 font-semibold">What is being asked</h2>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Request</dt>
                <dd>{view.label}</dd>
              </div>
              {view.subject && (
                <div>
                  <dt className="text-xs text-muted-foreground">{view.subject.label}</dt>
                  <dd>
                    {view.subject.href ? (
                      <Link href={view.subject.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                        {view.subject.name} <ArrowRight className="h-3 w-3" />
                      </Link>
                    ) : (
                      view.subject.name
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">Provider</dt>
                <dd>{view.provider ?? 'Platform-wide'}</dd>
              </div>
              {view.reason && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Reason given</dt>
                  <dd className="whitespace-pre-wrap rounded-md bg-secondary/50 p-2">{view.reason}</dd>
                </div>
              )}
            </dl>
          </section>

          {view.impact.length > 0 && (
            <section className="panel p-4 text-sm">
              <h2 className="mb-2 font-semibold">What approving does</h2>
              <ul className="list-inside list-disc space-y-1">
                {view.impact.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel p-4 text-sm">
            <div className="mb-3">
              <h2 className="font-semibold">{compare ? 'Changes' : 'Details'}</h2>
              <p className="text-xs text-muted-foreground">
                {view.comparedWith === 'NOW'
                  ? 'Compared with the record as it is right now.'
                  : view.comparedWith === 'AT_REQUEST'
                    ? 'Compared with the record as it was when this was requested.'
                    : 'What the request contains.'}
              </p>
            </div>
            {view.drifted && (
              <div className="mb-3 flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  The record has changed since this was requested, so the requester saw different values. Approving applies the proposed values over what is there now.
                </span>
              </div>
            )}
            {changed.length > 0 ? (
              rowsTable(changed)
            ) : (
              <p className="rounded-lg border border-border p-3 text-muted-foreground">No field differs from the record as it is now — approving changes nothing.</p>
            )}
            {unchanged.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {unchanged.length} field{unchanged.length === 1 ? '' : 's'} unchanged
                </summary>
                <div className="mt-2">{rowsTable(unchanged)}</div>
              </details>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="panel p-4 text-sm">
            <h2 className="mb-3 font-semibold">Decision</h2>
            {pending ? (
              <ChangeDecision changeId={change.id} canDecide={canDecide(user, view.kind)} isOwn={change.createdById === user.id} />
            ) : (
              <dl className="space-y-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Outcome</dt>
                  <dd className="font-medium">{OUTCOME[change.status] ?? change.status}</dd>
                </div>
                {view.decidedBy && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Decided by</dt>
                    <dd>{view.decidedBy}</dd>
                  </div>
                )}
                {view.decidedAt && (
                  <div>
                    <dt className="text-xs text-muted-foreground">When</dt>
                    <dd>{formatDateTime(view.decidedAt)}</dd>
                  </div>
                )}
                {view.comment && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Comment</dt>
                    <dd className="whitespace-pre-wrap">“{view.comment}”</dd>
                  </div>
                )}
                {view.failureReason && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Why it failed</dt>
                    <dd className="text-destructive">{view.failureReason}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          <section className="panel p-4 text-sm">
            <h2 className="mb-3 font-semibold">Request</h2>
            <dl className="space-y-2">
              <div>
                <dt className="text-xs text-muted-foreground">Requested by</dt>
                <dd>{view.requestedBy}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Requested</dt>
                <dd>
                  {formatDateTime(view.requestedAt)} <span className="text-muted-foreground">({timeAgo(view.requestedAt)})</span>
                </dd>
              </div>
              {change.summary && (
                <div>
                  <dt className="text-xs text-muted-foreground">Summary recorded</dt>
                  <dd>{change.summary}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">Reference</dt>
                <dd className="font-mono text-xs">{change.id}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
