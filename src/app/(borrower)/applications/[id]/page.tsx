import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import prisma from '@/lib/prisma';
import { requireBorrowerPage } from '@/lib/borrower-page';
import { parseRequiredDocuments } from '@/lib/documents';
import { centsToNumber, toCents } from '@/lib/money';
import { formatDateTime } from '@/lib/format';
import { brandStyle, brandTokens, honeycomb } from '@/lib/brand';
import { StatusBadge } from '@/components/admin/status-badge';
import { ProviderIcon } from '@/components/provider-icon';
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
      provider: { select: { name: true, colorHex: true, icon: true } },
      documents: { select: { documentKey: true, fileName: true, uploadedAt: true } },
      answers: { select: { documentKey: true, value: true } },
    },
  });
  if (!application) notFound();
  const required = parseRequiredDocuments(application.product.requiredDocuments);
  const { foreground } = brandTokens(application.provider.colorHex);

  return (
    <div className="space-y-4">
      <Link href="/loans" className="inline-flex items-center text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> My loans
      </Link>

      <section
        className="brand-surface relative overflow-hidden rounded-2xl p-4 shadow-lg"
        style={brandStyle(application.provider.colorHex)}
      >
        <div className="pointer-events-none absolute inset-0 opacity-60" style={honeycomb(foreground, 0.22)} aria-hidden />
        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] opacity-85">
                <ProviderIcon icon={application.provider.icon} className="h-3.5 w-3.5" />
                <span className="truncate">
                  {application.provider.name} · {application.applicationNo}
                </span>
              </p>
              <h1 className="truncate text-lg font-bold">{application.product.name}</h1>
            </div>
            <span className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ backgroundColor: 'var(--brand-chip)' }}>
              {application.status === 'SUBMITTED' ? 'Under review' : application.status.toLowerCase()}
            </span>
          </div>
          <p className="num mt-3 text-3xl font-bold tracking-tight">{money(centsToNumber(toCents(application.requestedAmount)))}</p>
          <p className="text-xs opacity-80">Submitted {formatDateTime(application.createdAt)}</p>
        </div>
      </section>

      {application.status === 'REJECTED' && application.reviewNote && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{application.reviewNote}</p>
      )}

      {application.status !== 'SUBMITTED' && (
        <p className="flex items-center justify-between rounded-xl border border-border bg-card p-3 text-sm">
          <StatusBadge status={application.status} />
          {application.loanId && (
            <Link href={`/loans/${application.loanId}`} className="inline-flex items-center gap-0.5 font-medium text-primary">
              View your loan <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </p>
      )}

      <ApplicationActions
        applicationId={application.id}
        open={application.status === 'SUBMITTED'}
        required={required.map((d) => ({ key: d.key, name: d.name, description: d.description ?? null, type: d.type }))}
        uploaded={application.documents.map((d) => ({ key: d.documentKey, fileName: d.fileName }))}
        answers={application.answers.map((a) => ({ key: a.documentKey, value: a.value }))}
      />
    </div>
  );
}
