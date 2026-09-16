import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { buildLoanView } from '@/lib/lending/loan-view';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => {
    const loans = await prisma.loan.findMany({
      where: { borrowerId: ctx.borrower.id },
      include: { installments: true, product: { select: { name: true } }, provider: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { loans: loans.map((l) => buildLoanView(l)) };
  });
}
