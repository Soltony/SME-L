import { NextRequest, NextResponse } from 'next/server';
import { deleteAdminSession, getCurrentUser } from '@/lib/session';
import { createAuditLog } from '@/lib/audit-log';
import { clientMeta } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser({ allowRefresh: false });
  await deleteAdminSession();

  if (user) {
    await createAuditLog({
      actorId: user.id,
      actorName: user.fullName,
      action: 'LOGOUT',
      ...clientMeta(req),
    });
  }

  return NextResponse.json({ ok: true });
}
