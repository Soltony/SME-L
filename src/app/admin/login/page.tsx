import { redirect } from 'next/navigation';
import { BookOpenCheck, Scale, ShieldCheck } from 'lucide-react';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { LogoMark } from '@/components/icons';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Staff sign in' };

const POINTS = [
  {
    icon: Scale,
    title: 'Books that balance',
    body: 'Every disbursement, accrual and repayment posts a balanced journal, verified against the loan book.',
  },
  {
    icon: ShieldCheck,
    title: 'Four eyes on money',
    body: 'Pricing, write-offs, reversals and capital all wait for a second approver.',
  },
  {
    icon: BookOpenCheck,
    title: 'Everything recorded',
    body: 'Sign-ins, decisions and exports are written to the audit trail.',
  },
];

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  const [user, params, settings] = await Promise.all([
    getCurrentUser({ allowRefresh: false }),
    searchParams,
    getSettings().catch(() => null),
  ]);
  if (user) redirect(user.passwordChangeRequired ? '/admin/change-password' : '/admin');
  const brand = String(settings?.['platform.name'] || 'SME Lending');

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
      <div className="auth-backdrop pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-4xl">
        <div className="grid overflow-hidden rounded-3xl border border-border bg-card shadow-[0_40px_80px_-40px_hsl(224_47%_9%/0.45)] lg:grid-cols-2">
          <section className="ink hidden flex-col justify-between gap-10 p-10 lg:flex">
            <span className="inline-flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <LogoMark />
              {brand}
            </span>
            <div>
              <h2 className="text-3xl font-extrabold leading-tight tracking-tight">Lending operations console</h2>
              <ul className="mt-8 space-y-5">
                {POINTS.map(({ icon: Icon, title, body }) => (
                  <li key={title} className="flex gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--ink-raised))] text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{title}</span>
                      <span className="block text-sm text-[hsl(var(--ink-muted))]">{body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-[hsl(var(--ink-muted))]">Authorised staff only.</p>
          </section>
          <LoginForm
            brand={brand}
            notice={params.passwordChanged ? 'Password updated. Sign in with your new password.' : null}
          />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Access is logged. Unauthorised use is prohibited.
        </p>
      </div>
    </main>
  );
}
