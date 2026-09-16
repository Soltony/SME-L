'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LogoWordmark } from '@/components/icons';
import { cn } from '@/lib/utils';

const FIELD = 'h-11 rounded-lg bg-secondary pl-10 focus-visible:bg-card';

export function LoginForm({ notice, brand }: { notice?: string | null; brand: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const fail = (message: string) => {
    setError(message);
    setShake(true);
    setTimeout(() => setShake(false), 520);
    passwordRef.current?.select();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        fail(data?.error || 'Sign in failed.');
        setBusy(false);
        return;
      }
      router.replace(data.redirectTo || '/admin');
      router.refresh();
    } catch {
      fail('Network error. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col justify-center px-7 py-10 sm:px-12">
      <form onSubmit={submit} className="mx-auto w-full max-w-sm">
        <div className="lg:hidden">
          <LogoWordmark name={brand} />
        </div>
        <h1 className="mt-6 text-2xl font-extrabold tracking-tight lg:mt-0">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Use your staff email and password.</p>

        <div className="mt-6 space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!error && notice && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={FIELD}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={cn(FIELD, 'pr-10')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={busy}
          className={cn(
            'gold mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-bold disabled:opacity-70',
            shake && 'shake'
          )}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Signing in' : 'Sign in'}
        </button>

        <p className="mt-6 border-t border-border pt-5 text-center text-xs text-muted-foreground">
          Locked out or need an account? Contact a system administrator.
        </p>
      </form>
    </div>
  );
}
