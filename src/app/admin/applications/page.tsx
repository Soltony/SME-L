import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { toCents } from '@/lib/money';
import { formatDateTime, normalizePhone } from '@/lib/format';
import { APPLICATION_STATUSES } from '@/lib/types';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge, statusLabel } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Applications' };

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const status = params.status ?? 'SUBMITTED';
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;
  const currency = String((await getSettings())['platform.currency'] || 'ETB');

  const where: Prisma.LoanApplicationWhereInput = {
    ...(user.providerId ? { providerId: user.providerId } : {}),
    ...((APPLICATION_STATUSES as readonly string[]).includes(status) ? { status } : {}),
  };
  const q = params.q?.trim();
  if (q) {
    where.OR = [
      { applicationNo: { contains: q } },
      { borrower: { phoneNumber: { contains: normalizePhone(q) || q } } },
      { borrower: { fullName: { contains: q } } },
    ];
  }

  const [applications, total] = await Promise.all([
    prisma.loanApplication.findMany({
      where,
      include: {
        borrower: { select: { fullName: true, phoneNumber: true, isNpl: true } },
        product: { select: { name: true, requiresReview: true, requiredDocuments: true } },
        provider: { select: { name: true } },
        _count: { select: { documents: true, answers: true } },
      },
      orderBy: { createdAt: status === 'SUBMITTED' ? 'asc' : 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.loanApplication.count({ where }),
  ]);

  return (
    <>
      <PageHeader
        title="Applications"
        description="Products marked for review wait here. Instant products are decided by the scoring model and disbursed straight away; they appear under their final status."
      />
      <FilterBar>
        <TextFilter name="q" label="Search" value={params.q} placeholder="Application no., phone or name" />
        <SelectFilter
          name="status"
          label="Status"
          value={status}
          allLabel="Any status"
          options={APPLICATION_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        />
        <FilterSubmit />
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Application</th>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 font-semibold">Product</th>
              <th className="px-4 py-2.5 text-right font-semibold">Requested</th>
              <th className="px-4 py-2.5 text-right font-semibold">Score</th>
              <th className="px-4 py-2.5 font-semibold">Documents</th>
              <th className="px-4 py-2.5 font-semibold">Submitted</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {applications.length === 0 && <EmptyRow colSpan={8} message="No applications match." />}
            {applications.map((a) => {
              const required = (() => {
                try {
                  return (JSON.parse(a.product.requiredDocuments) as unknown[]).length;
                } catch {
                  return 0;
                }
              })();
              return (
                <tr key={a.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/applications/${a.id}`} className="font-mono font-medium text-primary hover:underline">
                      {a.applicationNo}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">
                      {a.borrower.fullName ?? '—'} {a.borrower.isNpl && <StatusBadge status="NPL" className="ml-1" />}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{a.borrower.phoneNumber}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    {a.product.name}
                    {!user.providerId && <p className="text-xs text-muted-foreground">{a.provider.name}</p>}
                  </td>
                  <td className="num px-4 py-2.5 text-right">{moneyCents(toCents(a.requestedAmount), currency)}</td>
                  <td className="num px-4 py-2.5 text-right">{a.score ?? '—'}</td>
                  <td className="px-4 py-2.5">{required ? `${a._count.documents + a._count.answers}/${required}` : '—'}</td>
                  <td className="px-4 py-2.5 text-xs">{formatDateTime(a.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={a.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/applications" params={{ status, q: params.q }} />
      </TableCard>
    </>
  );
}
