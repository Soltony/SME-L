import prisma from '@/lib/prisma';
import { handle, isBorrowerFailure, requireBorrower, tooManyRequests, ApiError } from '@/lib/api';
import { providerCredit } from '@/lib/lending/provider-credit';
import { consumeRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * A provider's offer to the signed-in borrower: their limit, what is left of
 * it, and every product with its own decision.
 *
 * The home screen calls this when the borrower taps a provider, so switching
 * between providers costs one request each rather than one per product.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  const limit = consumeRateLimit('eligibility', ctx.borrower.id);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const { id } = await params;
  return handle(async () => {
    const provider = await prisma.loanProvider.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } });
    if (!provider) throw new ApiError(404, 'Lender not found.');
    return providerCredit(ctx.borrower, id);
  });
}
