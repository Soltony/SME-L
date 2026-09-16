import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Authoritative session endpoint, and the only place a refresh token is spent.
 *
 * The proxy calls this on every guarded request rather than duplicating JWT and
 * Prisma logic in the Edge runtime, so permissions are always read fresh from
 * the database — revoking a role takes effect at once.
 *
 * It is also where an expired access token is renewed. `allowRefresh` is passed
 * here and nowhere else: every other caller requires a valid access token, so a
 * refresh cookie on its own reaches this endpoint and no further. This is a
 * Route Handler, so the renewed cookie can actually be written; the proxy
 * forwards the `Set-Cookie` it comes back with, to the browser and to the
 * handler behind it.
 */
export async function GET() {
  const user = await getCurrentUser({ allowRefresh: true });

  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
    },
    role: user.role,
    roleId: user.roleId,
    permissions: user.permissions,
    passwordChangeRequired: user.passwordChangeRequired,
  });
}
