import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { parseRequiredDocuments } from '@/lib/documents';
import { centsToNumber, toCents } from '@/lib/money';
import { formatDateTime } from '@/lib/format';
import { StatusBadge } from '@/components/admin/status-badge';
import { money } from '@/components/money';
import { ApplicationActions } from './application-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Application' };

export default async function BorrowerApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { borrower } = await requireBorrowerPage();
  const { id } = await params;
  const application = await prisma.loanApplication.findFirst({
    where: { id, borrowerId: borrower.id },
    include: {
      product: { select: { name: true, requiredDocuments: true } },
      provider: { select: { name: true } },
      documents: { select: { documentKey: true, fileName: true, uploadedAt: true } },
    },
  });
  if (!application) notFound();
  const required = parseRequiredDocuments(application.product.requiredDocuments);

  return (
    <div className="space-y-4">
      <Link href="/loans" className="inline-flex items-center text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> My loans
      </Link>
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">
              {application.provider.name} · {application.applicationNo}
            </p>
            <h1 className="text-lg font-bold">{application.product.name}</h1>
          </div>
          <StatusBadge status={application.status} />
        </div>
        <p className="num mt-2 text-2xl font-bold">{money(centsToNumber(toCents(application.requestedAmount)))}</p>
        <p className="text-xs text-muted-foreground">Submitted {formatDateTime(application.createdAt)}</p>
        {application.status === 'REJECTED' && application.reviewNote && (
          <p className="mt-3 rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{application.reviewNote}</p>
        )}
        {application.loanId && (
          <Link href={`/loans/${application.loanId}`} className="mt-3 inline-block text-sm font-medium text-primary underline">
            View your loan
          </Link>
        )}
      </section>

      <ApplicationActions
        applicationId={application.id}
        open={application.status === 'SUBMITTED'}
        required={required.map((d) => ({ key: d.key, name: d.name, description: d.description ?? null }))}
        uploaded={application.documents.map((d) => ({ key: d.documentKey, fileName: d.fileName }))}
      />
    </div>
  );
}
