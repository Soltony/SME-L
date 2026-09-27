import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { formatDateTime, normalizePhone } from '@/lib/format';
import { BORROWER_DOCUMENT_STATUSES } from '@/lib/types';
import { PageHeader } from '@/components/admin/page-header';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { documentStatusKey, StatusBadge, statusLabel } from '@/components/admin/status-badge';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents' };

/**
 * Borrower documents waiting for review, oldest first.
 *
 * Each reviewer's queue is what they may decide: bank staff get the bank's
 * documents, a provider's staff their own provider's. Bank staff can also look
 * at providers' documents, read-only.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; owner?: string; q?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const status = params.status ?? 'PENDING';
  const owner = user.providerId ? 'mine' : (params.owner ?? 'bank');
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 25;

  const where: Prisma.BorrowerDocumentWhereInput = {
    ...(user.providerId
      ? { providerId: user.providerId }
      : owner === 'bank'
        ? { providerId: null }
        : owner === 'providers'
          ? { providerId: { not: null } }
          : {}),
    ...((BORROWER_DOCUMENT_STATUSES as readonly string[]).includes(status) ? { status } : {}),
  };
  const q = params.q?.trim();
  if (q) {
    where.borrower = { OR: [{ phoneNumber: { contains: normalizePhone(q) || q } }, { fullName: { contains: q } }] };
  }

  const [documents, total] = await Promise.all([
    prisma.borrowerDocument.findMany({
      where,
      include: {
        borrower: { select: { id: true, fullName: true, phoneNumber: true } },
        documentType: { select: { name: true, provider: { select: { name: true } } } },
      },
      orderBy: { submittedAt: status === 'PENDING' ? 'asc' : 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.borrowerDocument.count({ where }),
  ]);

  // A pending version with an approved one beside it is a replacement: the borrower is covered meanwhile.
  const approvedSiblings = documents.length
    ? await prisma.borrowerDocument.findMany({
        where: { status: 'APPROVED', OR: documents.map((d) => ({ borrowerId: d.borrowerId, documentTypeId: d.documentTypeId })) },
        select: { borrowerId: true, documentTypeId: true },
      })
    : [];
  const isReplacement = (d: (typeof documents)[number]) =>
    d.status === 'PENDING' && approvedSiblings.some((a) => a.borrowerId === d.borrowerId && a.documentTypeId === d.documentTypeId);

  const canDecide = hasPermission(user, 'documents', 'approve');

  return (
    <>
      <PageHeader
        title="Documents"
        description={
          user.providerId
            ? "Documents your products ask for. Borrowers cannot apply until they are approved. The bank's own documents are reviewed by bank staff."
            : "The bank's documents, asked of every borrower. Borrowers cannot apply until they are approved. Providers' documents are reviewed by each provider's own staff."
        }
      />
      <FilterBar>
        <TextFilter name="q" label="Borrower" value={params.q} placeholder="Phone or name" />
        <SelectFilter
          name="status"
          label="Status"
          value={status}
          allLabel="Any status"
          options={BORROWER_DOCUMENT_STATUSES.map((s) => ({ value: s, label: documentStatusLabel(s) }))}
        />
        {!user.providerId && (
          <SelectFilter
            name="owner"
            label="Documents"
            value={owner === 'all' ? '' : owner}
            allLabel="Bank and providers"
            options={[
              { value: 'bank', label: 'Bank documents' },
              { value: 'providers', label: 'Provider documents (view only)' },
            ]}
          />
        )}
        <FilterSubmit />
      </FilterBar>

      <TableCard>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Borrower</th>
              <th className="px-4 py-2.5 font-semibold">Document</th>
              <th className="px-4 py-2.5 font-semibold">Version</th>
              <th className="px-4 py-2.5 font-semibold">Submitted</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {documents.length === 0 && (
              <EmptyRow colSpan={6} message={status === 'PENDING' ? 'Nothing is waiting for review.' : 'No documents match.'} />
            )}
            {documents.map((d) => (
              <tr key={d.id} className="hover:bg-secondary/30">
                <td className="px-4 py-2.5">
                  <Link href={`/admin/borrowers/${d.borrower.id}`} className="font-medium text-primary hover:underline">
                    {d.borrower.fullName ?? '—'}
                  </Link>
                  <p className="font-mono text-xs text-muted-foreground">{d.borrower.phoneNumber}</p>
                </td>
                <td className="px-4 py-2.5">
                  {d.documentType.name}
                  <p className="text-xs text-muted-foreground">{d.documentType.provider?.name ?? 'Bank'}</p>
                </td>
                <td className="px-4 py-2.5">
                  v{d.version}
                  {isReplacement(d) && <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[11px]">replacement</span>}
                </td>
                <td className="px-4 py-2.5 text-xs">{formatDateTime(d.submittedAt)}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={documentStatusKey(d.status)} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Link href={`/admin/documents/${d.id}`} className="text-sm font-medium text-primary hover:underline">
                    {d.status === 'PENDING' && canDecide && (d.providerId ?? null) === (user.providerId ?? null) ? 'Review →' : 'View →'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/documents" params={{ status, owner: user.providerId ? undefined : owner, q: params.q }} />
      </TableCard>
    </>
  );
}

function documentStatusLabel(status: string) {
  return statusLabel(documentStatusKey(status));
}
