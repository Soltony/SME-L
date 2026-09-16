'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { LogoMark } from '@/components/icons';
import { Button } from '@/components/ui/button';

export function ConnectClient({ superAppToken, next, brand }: { superAppToken: string; next: string; brand: string }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const connect = async () => {
    setError(null);
    try {
      const response = await fetch('/api/app/auth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ superAppToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error || 'We could not sign you in.');
        return;
      }
      // A full navigation, so the next page is rendered with the new cookie.
      window.location.replace(next);
    } catch {
      setError('Network error. Check your connection and try again.');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <LogoMark className="h-12 w-12" />
      {error ? (
        <>
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
          <Button onClick={connect}>Try again</Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting to {brand}…
        </p>
      )}
    </main>
  );
}
