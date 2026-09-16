import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { buildLoanView, buildRepaymentView } from '@/lib/lending/loan-view';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const { id } = await params;
  return handle(async () => {
    const loan = await prisma.loan.findFirst({
      where: { id, borrowerId: ctx.borrower.id },
      include: {
        installments: true,
        product: { select: { name: true } },
        provider: { select: { name: true } },
        repayments: { orderBy: { receivedAt: 'desc' } },
      },
    });
    if (!loan) throw new ApiError(404, 'Loan not found.');
    return { loan: buildLoanView(loan), repayments: loan.repayments.map(buildRepaymentView) };
  });
}
