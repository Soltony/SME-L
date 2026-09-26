'use client';

import { useState } from 'react';
import { CheckCircle2, Landmark, Loader2, RefreshCw } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';

export interface BorrowerAccount {
  accountNumber: string;
  accountName: string | null;
}

/**
 * The bank accounts the platform has verified for this borrower.
 *
 * Reached by tapping the account number on the credit card. It is read-only on
 * purpose — which account a loan is paid into is chosen when applying, where
 * the decision belongs — but it is the one place a borrower can notice that an
 * account is missing, and ask the bank again, before they are mid-application.
 */
export function AccountsSheet({
  open,
  onOpenChange,
  accounts,
  shown,
  onRefreshed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: BorrowerAccount[];
  shown: string | null;
  onRefreshed: (accounts: BorrowerAccount[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/app/accounts', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error || 'Could not reach the bank. Please try again.');
        return;
      }
      onRefreshed(data.accounts ?? []);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-w-md rounded-t-2xl p-5">
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">Your bank accounts</SheetTitle>
          <SheetDescription className="text-xs">
            Verified with the bank from your phone number. You choose which one a loan is paid into when you apply.
          </SheetDescription>
        </SheetHeader>

        {accounts.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            We have no account for you yet. Ask the bank to look again, then apply.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {accounts.map((account) => (
              <li
                key={account.accountNumber}
                className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm"
              >
                <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="num block font-semibold">{account.accountNumber}</span>
                  {account.accountName && <span className="block truncate text-xs text-muted-foreground">{account.accountName}</span>}
                </span>
                {account.accountNumber === shown && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <Button variant="outline" className="mt-4 w-full" onClick={refresh} disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Check with the bank again
        </Button>
      </SheetContent>
    </Sheet>
  );
}
