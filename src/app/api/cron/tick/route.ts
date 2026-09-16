import { NextRequest, NextResponse } from 'next/server';
import { jsonError, tooManyRequests } from '@/lib/api';
import { consumeRateLimit } from '@/lib/rate-limit';
import { addressKey } from '@/lib/request-context';
import { optionalSecret, secretsMatch } from '@/lib/secrets';
import { runMaintenance } from '@/lib/maintenance';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduled maintenance. `curl -X POST -H "x-cron-secret: $CRON_SECRET" …/api/cron/tick`
 * The secret is compared in constant time; with no CRON_SECRET configured the
 * endpoint is closed.
 */
export async function POST(req: NextRequest) {
  const limit = consumeRateLimit('cronTick', addressKey(req.headers));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  let secret: string | null;
  try {
    secret = optionalSecret('CRON_SECRET', { minLength: 24 });
  } catch {
    secret = null;
  }
  if (!secret || !secretsMatch(req.headers.get('x-cron-secret'), secret)) {
    return jsonError('Forbidden', 403);
  }

  try {
    const summary = await runMaintenance();
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[cron] maintenance failed', error);
    return jsonError('Maintenance failed; see the server log.', 500);
  }
}
