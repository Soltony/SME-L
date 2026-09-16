import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { AuditDetails } from '@/components/admin/audit-details';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit Logs' };

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; actorType?: string; from?: string; to?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 50;
  const where: Prisma.AuditLogWhereInput = {
    ...(params.action ? { action: { contains: params.action.trim() } } : {}),
    ...(params.actor ? { OR: [{ actorId: { contains: params.actor.trim() } }, { actorName: { contains: params.actor.trim() } }] } : {}),
    ...(['ADMIN', 'BORROWER', 'SYSTEM', 'EXTERNAL'].includes(params.actorType ?? '') ? { actorType: params.actorType } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: new Date(`${params.from}T00:00:00Z`) } : {}),
            ...(params.to ? { lte: new Date(`${params.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  };
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditLog.count({ where }),
  ]);
  const exportQuery = new URLSearchParams(
    Object.entries({ from: params.from, to: params.to, action: params.action }).filter(([, v]) => v) as [string, string][]
  );

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Every sign-in, decision, posting and export. Credentials are redacted before anything is written."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/admin/audit-logs/export?${exportQuery.toString()}`}>Export CSV</a>
          </Button>
        }
      />
      <FilterBar>
        <TextFilter name="action" label="Action" value={params.action} placeholder="e.g. REPAYMENT" />
        <TextFilter name="actor" label="Actor" value={params.actor} placeholder="Name, id or phone" />
        <SelectFilter
          name="actorType"
          label="Actor type"
          value={params.actorType}
          options={['ADMIN', 'BORROWER', 'SYSTEM', 'EXTERNAL'].map((t) => ({ value: t, label: t }))}
        />
        <TextFilter name="from" label="From" type="date" value={params.from} />
        <TextFilter name="to" label="To" type="date" value={params.to} />
        <FilterSubmit />
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">When</th>
              <th className="px-4 py-2.5 font-semibold">Actor</th>
              <th className="px-4 py-2.5 font-semibold">Action</th>
              <th className="px-4 py-2.5 font-semibold">Entity</th>
              <th className="px-4 py-2.5 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs.length === 0 && <EmptyRow colSpan={5} message="No entries match." />}
            {logs.map((log) => (
              <tr key={log.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-2 text-xs">{formatDateTime(log.createdAt)}</td>
                <td className="px-4 py-2">
                  <p className="font-medium">{log.actorName ?? log.actorId}</p>
                  <p className="text-xs text-muted-foreground">{log.actorType}</p>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{log.action}</td>
                <td className="px-4 py-2 text-xs">
                  {log.entity ?? '—'}
                  {log.entityId && <p className="font-mono text-muted-foreground">{log.entityId}</p>}
                </td>
                <td className="px-4 py-2">
                  <AuditDetails details={log.details} ipAddress={log.ipAddress} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/audit-logs" params={{ action: params.action, actor: params.actor, actorType: params.actorType, from: params.from, to: params.to }} />
      </TableCard>
    </>
  );
}
