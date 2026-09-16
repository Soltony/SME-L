import { NextResponse } from 'next/server';
import { deleteBorrowerSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  await deleteBorrowerSession();
  return NextResponse.json({ ok: true });
}
