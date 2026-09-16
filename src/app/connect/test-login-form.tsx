'use client';

import { useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function TestLoginForm({ next }: { next: string }) {
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/app/auth/test-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, fullName }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error || 'Test sign-in failed.');
        return;
      }
      window.location.replace(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-warning/50 bg-warning/10 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <FlaskConical className="h-4 w-4" /> Test sign-in
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Enabled by ALLOW_TEST_LOGIN on this non-production server. Repayments from a test session skip the wallet and are recorded as TEST.
      </p>
      <div className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="t-phone">Phone number</Label>
          <Input id="t-phone" type="tel" inputMode="tel" maxLength={13} placeholder="0910000001" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="t-name">Name (new borrowers)</Label>
          <Input id="t-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Continue
        </Button>
      </div>
    </form>
  );
}
