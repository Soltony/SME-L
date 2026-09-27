import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { centsToNumber, toCents } from '@/lib/money';
import { parseDocumentSnapshot } from '@/lib/lending/document-requirements';
import { cancelApplication } from '@/lib/lending/applications';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const { id } = await params;
  return handle(async () => {
    const application = await prisma.loanApplication.findFirst({
      where: { id, borrowerId: ctx.borrower.id },
      include: {
        product: { select: { name: true } },
        provider: { select: { name: true } },
      },
    });
    if (!application) throw new ApiError(404, 'Application not found.');
    return {
      id: application.id,
      applicationNo: application.applicationNo,
      productName: application.product.name,
      providerName: application.provider.name,
      status: application.status,
      requestedAmount: centsToNumber(toCents(application.requestedAmount)),
      approvedAmount: application.approvedAmount ? centsToNumber(toCents(application.approvedAmount)) : null,
      reviewNote: application.status === 'REJECTED' ? application.reviewNote : null,
      loanId: application.loanId,
      // Which of their documents the decision relied on — names and versions, nothing more.
      documents: parseDocumentSnapshot(application.documentSnapshot).map((d) => ({ name: d.name, version: d.version })),
      createdAt: application.createdAt.toISOString(),
    };
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const { id } = await params;
  return handle(async () => {
    await cancelApplication(id, ctx.borrower);
    return { ok: true };
  });
}
