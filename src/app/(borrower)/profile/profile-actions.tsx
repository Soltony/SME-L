'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Landmark, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ProfileActions({ accounts }: { accounts: { accountNumber: string; accountName: string | null }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/app/accounts', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) setError(data?.error || 'Could not load accounts.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch('/api/app/auth/logout', { method: 'POST' });
    window.location.replace('/connect');
  };

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-4 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Bank accounts</h2>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Loans can only be paid into accounts the bank confirms are yours.</p>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <ul className="mt-2 space-y-2">
          {accounts.length === 0 && <li className="text-muted-foreground">None loaded yet.</li>}
          {accounts.map((a) => (
            <li key={a.accountNumber} className="flex items-center gap-2 rounded-lg bg-secondary/60 p-2">
              <Landmark className="h-4 w-4 text-muted-foreground" />
              <span>
                <span className="block font-mono">{a.accountNumber}</span>
                <span className="block text-xs text-muted-foreground">{a.accountName}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <Button variant="outline" className="w-full" onClick={signOut}>
        <LogOut className="mr-2 h-4 w-4" /> Sign out
      </Button>
    </>
  );
}
