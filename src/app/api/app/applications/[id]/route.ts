import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { centsToNumber, toCents } from '@/lib/money';
import { parseRequiredDocuments } from '@/lib/documents';
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
        product: { select: { name: true, requiredDocuments: true } },
        provider: { select: { name: true } },
        documents: { select: { documentKey: true, fileName: true, uploadedAt: true } },
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
      requiredDocuments: parseRequiredDocuments(application.product.requiredDocuments),
      documents: application.documents,
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
