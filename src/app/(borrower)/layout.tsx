import { requireBorrowerPage } from '@/lib/borrower-page';
import { getSettings } from '@/lib/settings';
import { BorrowerNav } from '@/components/borrower/borrower-nav';
import { LogoMark } from '@/components/icons';

export const dynamic = 'force-dynamic';

export default async function BorrowerLayout({ children }: { children: React.ReactNode }) {
  const [{ session, borrower }, settings] = await Promise.all([requireBorrowerPage(), getSettings()]);
  const brand = String(settings['platform.name'] || 'SME Lending');

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-background">
      {session.isTest && (
        <div className="bg-warning px-4 py-1.5 text-center text-xs font-semibold text-warning-foreground">
          Test session — repayments are simulated and recorded as TEST
        </div>
      )}
      <header className="ink sticky top-0 z-30 flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 font-bold">
          <LogoMark className="h-7 w-7" />
          {brand}
        </span>
        <span className="text-xs text-[hsl(var(--ink-muted))]">{borrower.fullName ?? borrower.phoneNumber}</span>
      </header>
      <main className="flex-1 px-4 pb-24 pt-4">{children}</main>
      <BorrowerNav />
    </div>
  );
}
