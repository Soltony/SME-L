import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, Check, Download, X } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { dayFromDate, dayToIso, formatDay } from '@/lib/business-date';
import { formatDateTime } from '@/lib/format';
import { DOCUMENT_KINDS, type DocumentKind } from '@/lib/document-kinds';
import { canReviewDocument, canViewBorrowerDocument, reviewerScopeError } from '@/lib/lending/borrower-documents';
import { PageHeader } from '@/components/admin/page-header';
import { documentStatusKey, StatusBadge } from '@/components/admin/status-badge';
import { ActionDialog } from '@/components/admin/action-dialog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Document' };

export default async function DocumentReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const doc = await prisma.borrowerDocument.findUnique({
    where: { id },
    include: {
      borrower: { select: { id: true, fullName: true, phoneNumber: true, status: true } },
      documentType: { select: { name: true, description: true, kind: true, requiresExpiry: true, scope: true, provider: { select: { name: true } } } },
    },
  });
  if (!doc || !(await canViewBorrowerDocument(user, doc))) notFound();

  const [history, duplicates] = await Promise.all([
    prisma.borrowerDocument.findMany({
      where: { borrowerId: doc.borrowerId, documentTypeId: doc.documentTypeId },
      orderBy: { version: 'desc' },
    }),
    // The same file under another borrower is worth a second look before approving.
    doc.sha256
      ? prisma.borrowerDocument.findMany({
          where: { sha256: doc.sha256, NOT: { borrowerId: doc.borrowerId } },
          select: { id: true, borrower: { select: { id: true, fullName: true, phoneNumber: true } }, documentType: { select: { name: true } } },
          take: 10,
        })
      : Promise.resolve([]),
  ]);

  const kind = (doc.documentType.kind in DOCUMENT_KINDS ? doc.documentType.kind : 'FILE') as DocumentKind;
  const owner = doc.documentType.provider?.name ?? 'Bank';
  const approvedNow = history.find((v) => v.status === 'APPROVED' && v.id !== doc.id);
  const open = doc.status === 'PENDING';
  const mayDecide = open && canReviewDocument(user, doc.providerId);
  const scopeNote = open ? reviewerScopeError(user, doc.providerId) : null;
  const expiryIso = doc.expiresOn ? dayToIso(dayFromDate(doc.expiresOn)) : '';

  return (
    <>
      <PageHeader
        title={`${doc.documentType.name} · v${doc.version}`}
        breadcrumbs={[{ label: 'Documents', href: '/admin/documents' }, { label: doc.borrower.fullName ?? doc.borrower.phoneNumber }]}
        description={`${owner === 'Bank' ? 'Bank document, required from every borrower' : `${owner} document`} · ${DOCUMENT_KINDS[kind].label}`}
        actions={
          <>
            <StatusBadge status={documentStatusKey(doc.status)} className="mr-1" />
            {mayDecide && (
              <>
                <ActionDialog
                  label="Approve"
                  variant="default"
                  icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                  title={`Approve ${doc.documentType.name}`}
                  description={
                    approvedNow
                      ? `Replaces version ${approvedNow.version}, which stops counting once this is approved.`
                      : 'Counts towards every application that asks for it, from now on.'
                  }
                  endpoint={`/api/admin/documents/${doc.id}`}
                  extra={{ action: 'approve' }}
                  submitLabel="Approve"
                  fields={[
                    ...(doc.documentType.requiresExpiry
                      ? [{ name: 'expiresOn', label: 'Expiry date (YYYY-MM-DD)', defaultValue: expiryIso, required: true, help: 'As printed on the document. Correct it if the borrower typed it wrong.' }]
                      : []),
                    { name: 'note', label: 'Note (optional)', type: 'textarea' as const },
                  ]}
                />
                <ActionDialog
                  label="Reject"
                  destructive
                  icon={<X className="mr-1.5 h-3.5 w-3.5" />}
                  title={`Reject ${doc.documentType.name}`}
                  description={
                    approvedNow
                      ? `The borrower is told by SMS. Version ${approvedNow.version} stays approved and in use.`
                      : 'The borrower is told by SMS, with the reason, and can upload it again.'
                  }
                  endpoint={`/api/admin/documents/${doc.id}`}
                  extra={{ action: 'reject' }}
                  submitLabel="Reject"
                  fields={[{ name: 'note', label: 'Reason shown to the borrower', type: 'textarea', required: true }]}
                />
              </>
            )}
          </>
        }
      />

      {scopeNote && (
        <div className="mb-4 rounded-lg border border-border bg-secondary/50 p-3 text-sm">{scopeNote} You can view it but not decide it.</div>
      )}
      {duplicates.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            The same file was also provided by another borrower:{' '}
            {duplicates.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <Link href={`/admin/documents/${d.id}`} className="text-primary hover:underline">
                  {d.borrower.fullName ?? d.borrower.phoneNumber}
                </Link>{' '}
                ({d.documentType.name})
              </span>
            ))}
            . Check it belongs to this borrower before approving.
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 text-sm lg:col-span-2">
          <h2 className="mb-3 font-semibold">This version</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Borrower</dt>
              <dd>
                <Link href={`/admin/borrowers/${doc.borrower.id}`} className="text-primary hover:underline">
                  {doc.borrower.fullName ?? '—'}
                </Link>
                <span className="block font-mono text-xs text-muted-foreground">{doc.borrower.phoneNumber}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Submitted</dt>
              <dd>{formatDateTime(doc.submittedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd>{doc.expiresOn ? formatDay(dayFromDate(doc.expiresOn)) : doc.documentType.requiresExpiry ? 'Not given' : 'Not asked'}</dd>
            </div>
            <div className="col-span-2 md:col-span-3">
              <dt className="text-xs text-muted-foreground">{kind === 'TEXT' ? 'Value typed' : 'File'}</dt>
              <dd>
                {kind === 'TEXT' ? (
                  <span className="break-words font-mono">{doc.value}</span>
                ) : (
                  <a
                    href={`/api/admin/documents/${doc.id}/file`}
                    className="inline-flex items-center gap-1.5 text-primary hover:underline"
                    title={doc.sha256 ? `SHA-256 ${doc.sha256}` : undefined}
                  >
                    <Download className="h-4 w-4" />
                    {doc.fileName} · {((doc.sizeBytes ?? 0) / 1024).toFixed(0)} KB
                  </a>
                )}
              </dd>
            </div>
            {doc.reviewedByName && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-xs text-muted-foreground">Reviewed</dt>
                <dd>
                  {doc.reviewedByName} · {formatDateTime(doc.reviewedAt)}
                  {doc.reviewNote && <span className="mt-1 block rounded-md bg-secondary/60 p-2">{doc.reviewNote}</span>}
                </dd>
              </div>
            )}
          </dl>
          {doc.documentType.description && (
            <p className="mt-4 text-xs text-muted-foreground">What was asked: {doc.documentType.description}</p>
          )}
        </section>

        <section className="panel p-4 text-sm">
          <h2 className="mb-3 font-semibold">All versions</h2>
          <ul className="space-y-2">
            {history.map((v) => (
              <li key={v.id} className={v.id === doc.id ? 'rounded-md border border-primary/40 p-2' : 'rounded-md border border-border p-2'}>
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/admin/documents/${v.id}`} className="font-medium text-primary hover:underline">
                    Version {v.version}
                  </Link>
                  <StatusBadge status={documentStatusKey(v.status)} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Sent {formatDateTime(v.submittedAt)}
                  {v.reviewedByName && ` · ${v.reviewedByName}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
