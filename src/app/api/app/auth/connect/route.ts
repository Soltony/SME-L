import { NextRequest, NextResponse } from 'next/server';
import { clientMeta, handle, readJsonBody, tooManyRequests } from '@/lib/api';
import { connectBorrower } from '@/lib/borrower-connect';
import { consumeRateLimit } from '@/lib/rate-limit';
import { addressKey } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

/** Exchanges the super-app token for a borrower session cookie. */
export async function POST(req: NextRequest) {
  const limit = consumeRateLimit('sessionExchange', addressKey(req.headers));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonBody<{ superAppToken?: string }>(req);
  if (body instanceof NextResponse) return body;

  return handle(async () => {
    const token = String(body.superAppToken || req.headers.get('authorization') || '');
    const result = await connectBorrower(token, clientMeta(req));
    return { ok: true, isNew: result.isNew };
  });
}
