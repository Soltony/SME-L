import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, Download, X } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { centsToNumber, toCents } from '@/lib/money';
import { formatDateTime, maskAccount } from '@/lib/format';
import { DOCUMENT_KINDS, missingDocuments, parseRequiredDocuments } from '@/lib/documents';
import { evaluateEligibility } from '@/lib/lending/eligibility';
import { prepareCoreBankingForProduct } from '@/lib/lending/core-banking-profile';
import { PageHeader } from '@/components/admin/page-header';
import { StatusBadge } from '@/components/admin/status-badge';
import { ActionDialog } from '@/components/admin/action-dialog';
import { money } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Application' };

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const { id } = await params;
  const application = await prisma.loanApplication.findUnique({
    where: { id },
    include: {
      borrower: true,
      product: true,
      provider: { select: { name: true } },
      documents: { orderBy: { uploadedAt: 'asc' } },
      answers: true,
    },
  });
  if (!application || (user.providerId && application.providerId !== user.providerId)) notFound();

  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const required = parseRequiredDocuments(application.product.requiredDocuments);
  const uploaded = new Map(application.documents.map((d) => [d.documentKey, d]));
  const answers = new Map(application.answers.map((a) => [a.documentKey, a]));
  const missing = missingDocuments(required, { files: uploaded.keys(), answers: answers.keys() });
  const open = application.status === 'SUBMITTED';
  // Re-evaluated now: the reviewer decides on today's position, not the one at submission.
  if (open) await prepareCoreBankingForProduct(application.borrowerId, application.productId);
  const now = open
    ? await evaluateEligibility(prisma, application.borrower, application.productId, { excludeApplicationId: application.id })
    : null;
  const canDecide = open && hasPermission(user, 'applications', 'approve');
  const requested = centsToNumber(toCents(application.requestedAmount));

  return (
    <>
      <PageHeader
        title={application.applicationNo}
        breadcrumbs={[{ label: 'Applications', href: '/admin/applications' }, { label: application.applicationNo }]}
        description={`${application.product.name} · ${application.provider.name}`}
        actions={
          <>
            <StatusBadge status={application.status} className="mr-1" />
            {application.loanId && (
              <Link href={`/admin/loans/${application.loanId}`} className="text-sm font-medium text-primary hover:underline">
                View loan →
              </Link>
            )}
            {canDecide && (
              <>
                <ActionDialog
                  label="Approve"
                  variant="default"
                  icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                  title="Approve and disburse"
                  description={
                    now?.eligible
                      ? `Qualifies today for up to ${money(centsToNumber(now.maxAmount), currency)}. Approving creates the loan and sends the money to the borrower's verified account immediately.`
                      : `Does not qualify today: ${now?.reason ?? ''}`
                  }
                  endpoint={`/api/admin/applications/${application.id}`}
                  extra={{ action: 'approve' }}
                  submitLabel="Approve & disburse"
                  disabled={!now?.eligible || missing.length > 0}
                  fields={[
                    { name: 'amount', label: `Amount (${currency})`, type: 'amount', defaultValue: String(Math.min(requested, centsToNumber(now?.maxAmount ?? 0))), help: `Requested ${money(requested, currency)}. You can approve less, never more.` },
                    { name: 'note', label: 'Review note', type: 'textarea' },
                  ]}
                />
                <ActionDialog
                  label="Reject"
                  destructive
                  icon={<X className="mr-1.5 h-3.5 w-3.5" />}
                  title="Reject application"
                  description="The borrower is told by SMS, with the reason."
                  endpoint={`/api/admin/applications/${application.id}`}
                  extra={{ action: 'reject' }}
                  submitLabel="Reject"
                  fields={[{ name: 'reason', label: 'Reason shown to the borrower', type: 'textarea', required: true }]}
                />
              </>
            )}
          </>
        }
      />

      {open && missing.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Waiting for the borrower to provide: {missing.map((d) => d.name).join(', ')}. It cannot be approved until they do.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 text-sm lg:col-span-2">
          <h2 className="mb-3 font-semibold">Request</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Borrower</dt>
              <dd>
                <Link href={`/admin/borrowers/${application.borrowerId}`} className="text-primary hover:underline">
                  {application.borrower.fullName ?? application.borrower.phoneNumber}
                </Link>
                {application.borrower.isNpl && <StatusBadge status="NPL" className="ml-1" />}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Phone</dt>
              <dd className="font-mono">{application.borrower.phoneNumber}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Submitted</dt>
              <dd>{formatDateTime(application.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Requested</dt>
              <dd className="num font-semibold">{money(requested, currency)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Limit at submission</dt>
              <dd className="num">{application.eligibleAmount ? money(centsToNumber(toCents(application.eligibleAmount)), currency) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Score at submission</dt>
              <dd>{application.score ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pay to (verified)</dt>
              <dd className="font-mono">{maskAccount(application.disbursementAccount)}</dd>
            </div>
            {application.approvedAmount && (
              <div>
                <dt className="text-xs text-muted-foreground">Approved</dt>
                <dd className="num">{money(centsToNumber(toCents(application.approvedAmount)), currency)}</dd>
              </div>
            )}
            {application.reviewedByName && (
              <div>
                <dt className="text-xs text-muted-foreground">Reviewed by</dt>
                <dd>
                  {application.reviewedByName} · {formatDateTime(application.reviewedAt)}
                </dd>
              </div>
            )}
          </dl>
          {application.reviewNote && <p className="mt-3 rounded-md bg-secondary/60 p-2">{application.reviewNote}</p>}
        </section>

        <section className="panel p-4 text-sm">
          <h2 className="mb-3 font-semibold">Documents</h2>
          {required.length === 0 ? (
            <p className="text-muted-foreground">This product asks for no documents.</p>
          ) : (
            <ul className="space-y-2">
              {required.map((doc) => {
                if (doc.type === 'TEXT') {
                  const answer = answers.get(doc.key);
                  return (
                    <li key={doc.key} className="rounded-md border border-border p-2">
                      <span className="block font-medium">{doc.name}</span>
                      {answer ? (
                        <>
                          <span className="block break-words">{answer.value}</span>
                          <span className="block text-xs text-muted-foreground">Typed · {formatDateTime(answer.answeredAt)}</span>
                        </>
                      ) : (
                        <span className="block text-xs text-muted-foreground">Not provided · typed answer</span>
                      )}
                    </li>
                  );
                }
                const file = uploaded.get(doc.key);
                return (
                  <li key={doc.key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
                    <span>
                      <span className="block font-medium">{doc.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {file
                          ? `${file.fileName} · ${(file.sizeBytes / 1024).toFixed(0)} KB · ${formatDateTime(file.uploadedAt)}`
                          : `Not uploaded · ${DOCUMENT_KINDS[doc.type].label.toLowerCase()}`}
                      </span>
                    </span>
                    {file && (
                      <a
                        href={`/api/admin/applications/${application.id}/documents/${file.id}`}
                        className="rounded-md p-1.5 text-primary hover:bg-secondary"
                        title={`Download (SHA-256 ${file.sha256.slice(0, 12)}…)`}
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {now && (
        <section className="panel mt-4 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Eligibility today</h2>
            <span className={now.eligible ? 'font-semibold text-success' : 'font-semibold text-destructive'}>
              {now.eligible ? `Eligible up to ${money(centsToNumber(now.maxAmount), currency)}` : now.reason}
            </span>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">Parameter</th>
                  <th className="py-1">Matched rule</th>
                  <th className="py-1 text-right">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {now.breakdown.map((b) => (
                  <tr key={b.parameter}>
                    <td className="py-1.5">{b.parameter}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{b.matchedRule ?? 'none'}</td>
                    <td className="num py-1.5 text-right">
                      {b.points}/{b.weight}
                    </td>
                  </tr>
                ))}
                {now.score !== null && (
                  <tr className="font-semibold">
                    <td className="py-1.5">Total</td>
                    <td />
                    <td className="num py-1.5 text-right">
                      {now.score}/{now.maxScore}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <dl className="space-y-1.5">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Product maximum</dt>
                <dd className="num">{money(centsToNumber(now.limits.productMax), currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tier for this score</dt>
                <dd className="num">{now.limits.tierMax === null ? 'not scored' : money(centsToNumber(now.limits.tierMax), currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Loan cycle share</dt>
                <dd className="text-right">
                  {now.limits.cyclePercent === null ? '—' : `${now.limits.cyclePercent}%`}
                  {now.limits.cycleStage && <span className="block text-xs text-muted-foreground">{now.limits.cycleStage}</span>}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Already owed to this provider</dt>
                <dd className="num">{money(centsToNumber(now.limits.outstandingWithProvider), currency)}</dd>
              </div>
            </dl>
          </div>
        </section>
      )}
    </>
  );
}
