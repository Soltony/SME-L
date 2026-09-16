import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { productCard } from '@/lib/lending/product-view';
import { borrowerPhoneNumbers } from '@/lib/lending/borrower-identity';
import { visibleToBorrower } from '@/lib/lending/eligibility-lists';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => {
    const numbers = await borrowerPhoneNumbers(prisma, ctx.borrower);
    const products = await prisma.loanProduct.findMany({
      where: { status: 'ACTIVE', provider: { status: 'ACTIVE' }, ...visibleToBorrower(numbers) },
      include: { provider: { select: { name: true, colorHex: true, icon: true, displayOrder: true } } },
      orderBy: [{ provider: { displayOrder: 'asc' } }, { name: 'asc' }],
    });
    return { products: products.map(productCard) };
  });
}
