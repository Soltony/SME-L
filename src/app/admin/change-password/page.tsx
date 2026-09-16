import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import { LogoWordmark } from '@/components/icons';
import { ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Change password' };

export default async function ChangePasswordPage() {
  const user = await getCurrentUser({ allowRefresh: false });
  if (!user) redirect('/admin/login');

  return (
    <div className="flex min-h-screen items-center justify-center bg-secondary/40 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoWordmark className="text-xl" />
          <p className="mt-2 text-sm text-muted-foreground">
            {user.passwordChangeRequired ? 'Set a new password before continuing.' : 'Update your password.'}
          </p>
        </div>
        <ChangePasswordForm required={user.passwordChangeRequired} />
      </div>
    </div>
  );
}
