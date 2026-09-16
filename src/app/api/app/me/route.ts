import { handle, isBorrowerFailure, requireBorrower } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await requireBorrower();
  if (isBorrowerFailure(ctx)) return ctx.response;
  return handle(async () => ({
    phoneNumber: ctx.borrower.phoneNumber,
    fullName: ctx.borrower.fullName,
    isNpl: ctx.borrower.isNpl,
    isTest: Boolean(ctx.session.isTest),
  }));
}
