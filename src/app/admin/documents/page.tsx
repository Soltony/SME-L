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
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents' };

/** The dot on each document chip, so a borrower's documents read at a glance when their statuses differ. */
const STATUS_DOT: Record<string, string> = {
  PENDING: 'bg-warning',
  APPROVED: 'bg-success',
  REJECTED: 'bg-destructive',
};

/**
 * Borrower documents waiting for review, oldest first, one entry per borrower.
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

  // A page is a page of borrowers, each one row carrying every matching
  // document. The queue stays oldest first: by each borrower's longest wait.
  const oldestFirst = status === 'PENDING';
  const [borrowerPage, total] = await Promise.all([
    prisma.borrowerDocument.groupBy({
      by: ['borrowerId'],
      where,
      orderBy: [oldestFirst ? { _min: { submittedAt: 'asc' } } : { _max: { submittedAt: 'desc' } }, { borrowerId: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.borrower.count({ where: { documents: { some: where } } }),
  ]);
  const documents = borrowerPage.length
    ? await prisma.borrowerDocument.findMany({
        where: { ...where, borrowerId: { in: borrowerPage.map((b) => b.borrowerId) } },
        include: {
          borrower: { select: { id: true, fullName: true, phoneNumber: true } },
          documentType: { select: { name: true, provider: { select: { name: true } } } },
        },
        orderBy: [{ submittedAt: oldestFirst ? 'asc' : 'desc' }, { documentType: { name: 'asc' } }],
      })
    : [];
  const borrowers = borrowerPage
    .map((b) => documents.filter((d) => d.borrowerId === b.borrowerId))
    .filter((docs) => docs.length > 0);

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
              <th className="px-4 py-2.5 font-semibold">Documents</th>
              <th className="px-4 py-2.5 font-semibold">Submitted</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {borrowers.length === 0 && (
              <EmptyRow colSpan={5} message={status === 'PENDING' ? 'Nothing is waiting for review.' : 'No documents match.'} />
            )}
            {borrowers.map((docs) => {
              const borrower = docs[0].borrower;
              const owners = [...new Set(docs.map((d) => d.documentType.provider?.name ?? 'Bank'))];
              const statuses = BORROWER_DOCUMENT_STATUSES.filter((s) => docs.some((d) => d.status === s));
              // Where "Review" starts: the document of theirs this reviewer has waited on longest.
              const next = docs.find((d) => d.status === 'PENDING' && canDecide && (d.providerId ?? null) === (user.providerId ?? null));
              return (
                <tr key={borrower.id} className="hover:bg-secondary/30">
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link href={`/admin/borrowers/${borrower.id}`} className="font-medium text-primary hover:underline">
                      {borrower.fullName ?? '—'}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{borrower.phoneNumber}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {docs.map((d) => (
                        <Link
                          key={d.id}
                          href={`/admin/documents/${d.id}`}
                          title={`${documentStatusLabel(d.status)} · version ${d.version} · sent ${formatDateTime(d.submittedAt)}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium transition hover:border-primary hover:text-primary"
                        >
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[d.status] ?? 'bg-muted-foreground/50')} />
                          {d.documentType.name}
                          {(d.version > 1 || isReplacement(d)) && (
                            <span className="font-normal text-muted-foreground">
                              v{d.version}
                              {isReplacement(d) && ' · replacement'}
                            </span>
                          )}
                        </Link>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{owners.join(', ')}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs">{formatDateTime(docs[0].submittedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {statuses.map((s) => (
                        <StatusBadge key={s} status={documentStatusKey(s)} className="whitespace-nowrap" />
                      ))}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <Link href={`/admin/documents/${(next ?? docs[0]).id}`} className="text-sm font-medium text-primary hover:underline">
                      {next ? 'Review →' : 'View →'}
                    </Link>
                  </td>
                </tr>
              );
            })}
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
