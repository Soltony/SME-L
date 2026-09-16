'use client';

import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PASSWORD_MIN_LENGTH } from '@/lib/admin-users';

const RULES = [
  { label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (v: string) => v.length >= PASSWORD_MIN_LENGTH },
  { label: 'A lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { label: 'An uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'A number', test: (v: string) => /[0-9]/.test(v) },
  { label: 'A symbol', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

export function ChangePasswordForm({ required }: { required: boolean }) {
  const [form, setForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const allRulesPass = RULES.every((rule) => rule.test(form.newPassword));
  const matches = form.newPassword.length > 0 && form.newPassword === form.confirmPassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data?.error || 'Could not change the password.');
        return;
      }

      // The server signed this client out, so leave with a full page load to
      // drop the client router cache of the authenticated screens.
      window.location.replace(data.redirectTo || '/admin/login');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          {required
            ? 'Your account uses a temporary password that must be replaced.'
            : 'Changing your password signs out every session, including this one.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={form.currentPassword}
              onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              value={form.newPassword}
              onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
            />
          </div>

          <ul className="space-y-1">
            {RULES.map((rule) => {
              const passed = rule.test(form.newPassword);
              return (
                <li
                  key={rule.label}
                  className={cn(
                    'flex items-center gap-1.5 text-xs',
                    passed ? 'text-success' : 'text-muted-foreground'
                  )}
                >
                  {passed ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                  {rule.label}
                </li>
              );
            })}
          </ul>

          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={form.confirmPassword}
              onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}
            />
            {form.confirmPassword.length > 0 && !matches && (
              <p className="text-xs text-destructive">Passwords do not match.</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={loading || !allRulesPass || !matches}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
