import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, requireBorrower } from '@/lib/api';
import { productCard } from '@/lib/lending/product-view';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => {
    const products = await prisma.loanProduct.findMany({
      where: { status: 'ACTIVE', provider: { status: 'ACTIVE' } },
      include: { provider: { select: { name: true, colorHex: true, displayOrder: true } } },
      orderBy: [{ provider: { displayOrder: 'asc' } }, { name: 'asc' }],
    });
    return { products: products.map(productCard) };
  });
}
