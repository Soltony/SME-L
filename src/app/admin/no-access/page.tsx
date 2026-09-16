import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { getCurrentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'No access' };

export default async function NoAccessPage() {
  const user = await getCurrentUser({ allowRefresh: false });

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
        <ShieldAlert className="h-7 w-7 text-destructive" />
      </div>
      <div>
        <h1 className="text-xl font-bold">You do not have access to this page</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your role{user ? ` (${user.role})` : ''} does not include permission for this module. Ask
          a Super Admin to grant it in Access Control.
        </p>
      </div>
      <Link
        href="/admin"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
