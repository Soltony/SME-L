import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { formatDateTime, normalizePhone } from '@/lib/format';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Borrowers' };

export default async function BorrowersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; npl?: string; status?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;

  const where: Prisma.BorrowerWhereInput = {
    // Provider staff see borrowers who have dealt with their provider.
    ...(user.providerId ? { applications: { some: { providerId: user.providerId } } } : {}),
    ...(params.npl === '1' ? { isNpl: true } : {}),
    ...(['ACTIVE', 'BLOCKED'].includes(params.status ?? '') ? { status: params.status } : {}),
  };
  const q = params.q?.trim();
  if (q) where.OR = [{ phoneNumber: { contains: normalizePhone(q) || q } }, { fullName: { contains: q } }];

  const [borrowers, total] = await Promise.all([
    prisma.borrower.findMany({
      where,
      include: {
        _count: { select: { loans: true } },
        loans: {
          where: { status: 'ACTIVE', ...(user.providerId ? { providerId: user.providerId } : {}) },
          select: { daysPastDue: true },
        },
      },
      orderBy: { lastSeenAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.borrower.count({ where }),
  ]);

  return (
    <>
      <PageHeader title="Borrowers" description="Borrowers are registered the first time they open the app from the super app." />
      <FilterBar>
        <TextFilter name="q" label="Search" value={params.q} placeholder="Phone or name" />
        <SelectFilter name="npl" label="Classification" value={params.npl} allLabel="Any" options={[{ value: '1', label: 'NPL only' }]} />
        <SelectFilter name="status" label="Status" value={params.status} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'BLOCKED', label: 'Blocked' }]} />
        <FilterSubmit />
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[800px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 text-right font-semibold">Loans</th>
              <th className="px-4 py-2.5 text-right font-semibold">Active</th>
              <th className="px-4 py-2.5 text-right font-semibold">Worst DPD now</th>
              <th className="px-4 py-2.5 font-semibold">Last seen</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {borrowers.length === 0 && <EmptyRow colSpan={6} message="No borrowers match." />}
            {borrowers.map((b) => {
              const worst = b.loans.reduce((max, l) => Math.max(max, l.daysPastDue), 0);
              return (
                <tr key={b.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/borrowers/${b.id}`} className="font-medium text-primary hover:underline">
                      {b.fullName ?? 'Unnamed'}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{b.phoneNumber}</p>
                  </td>
                  <td className="num px-4 py-2.5 text-right">{b._count.loans}</td>
                  <td className="num px-4 py-2.5 text-right">{b.loans.length}</td>
                  <td className={`num px-4 py-2.5 text-right ${worst > 0 ? 'font-semibold text-destructive' : ''}`}>{worst}</td>
                  <td className="px-4 py-2.5 text-xs">{formatDateTime(b.lastSeenAt)}</td>
                  <td className="space-x-1 px-4 py-2.5">
                    <StatusBadge status={b.status} />
                    {b.isNpl && <StatusBadge status="NPL" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/borrowers" params={{ q: params.q, npl: params.npl, status: params.status }} />
      </TableCard>
    </>
  );
}
