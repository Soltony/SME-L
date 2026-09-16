import { NextRequest, NextResponse } from 'next/server';
import { clientMeta, readJsonBody } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { addressKey } from '@/lib/request-context';
import { processGatewayCallback } from '@/lib/lending/payments';

export const dynamic = 'force-dynamic';

/** Super-app payment gateway callback. See `processGatewayCallback` for the checks, in order. */
export async function POST(req: NextRequest) {
  const limit = consumeRateLimit('paymentCallback', addressKey(req.headers));
  if (!limit.ok) {
    return NextResponse.json(
      { message: 'Too many requests.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const result = await processGatewayCallback(body, req.headers.get('authorization'), clientMeta(req));
  return NextResponse.json({ message: result.message }, { status: result.httpStatus });
}
