import { NextRequest, NextResponse } from 'next/server';
import { clientMeta, handle, jsonError, readJsonBody, tooManyRequests } from '@/lib/api';
import { openBorrowerSession } from '@/lib/borrower-connect';
import { isTestLoginEnabled } from '@/lib/dev-switches';
import { parseEthiopianMobile } from '@/lib/format';
import { consumeRateLimit } from '@/lib/rate-limit';
import { addressKey } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

/**
 * Opens a borrower session without a super-app token, for testing. Refused
 * unless ALLOW_TEST_LOGIN=true — and always refused in production. Repayments
 * from a test session never touch the gateway and are recorded as TEST.
 */
export async function POST(req: NextRequest) {
  if (!isTestLoginEnabled()) return jsonError('Test sign-in is not enabled on this environment.', 403);

  const limit = consumeRateLimit('testLogin', addressKey(req.headers));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonBody<{ phone?: string; fullName?: string }>(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    const phone = parseEthiopianMobile(String(body.phone || ''));
    if (!phone) return jsonError('Enter an Ethiopian mobile number, such as 0911223344.', 400, { field: 'phone' });
    await openBorrowerSession(phone, {
      superAppToken: '',
      isTest: true,
      fullName: String(body.fullName || '').trim().slice(0, 100) || null,
      ...clientMeta(req),
    });
    return { ok: true };
  });
}

export async function GET() {
  return NextResponse.json({ enabled: isTestLoginEnabled() });
}
