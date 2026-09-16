import prisma from '@/lib/prisma';
import { ApiError, handle, isBorrowerFailure, requireBorrower } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Polled by the borrower app while the wallet confirms a payment. */
export async function GET(_req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const { transactionId } = await params;
  return handle(async () => {
    const intent = await prisma.paymentIntent.findFirst({
      where: { transactionId, borrowerId: ctx.borrower.id },
      select: { status: true, loanId: true, repayments: { select: { receiptNo: true }, take: 1 } },
    });
    if (!intent) throw new ApiError(404, 'Payment not found.');
    return { status: intent.status, loanId: intent.loanId, receiptNo: intent.repayments[0]?.receiptNo ?? null };
  });
}
