'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, KeyRound, Loader2, LockOpen, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { useToast } from '@/hooks/use-toast';

interface UserRow {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  status: string;
  roleId: string;
  roleName: string;
  providerId: string | null;
  providerName: string | null;
  passwordChangeRequired: boolean;
  lastLoginAt: string | null;
  locked: boolean;
}

/** The server names the input its complaint belongs to; this puts it there. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs font-medium text-destructive">
      {message}
    </p>
  );
}

/** Marks an input as rejected, for the browser and for the eye. */
function invalidProps(id: string, message?: string) {
  if (!message) return {};
  return {
    'aria-invalid': true,
    'aria-describedby': id,
    className: 'border-destructive focus-visible:ring-destructive',
  };
}

const blank = {
  id: '',
  fullName: '',
  email: '',
  phoneNumber: '',
  roleId: '',
  providerId: '',
  status: 'ACTIVE',
};

export function UsersManager({
  users,
  roles,
  providers,
  currentUserId,
  canCreate,
  canUpdate,
}: {
  users: UserRow[];
  roles: { id: string; name: string }[];
  providers: { id: string; name: string }[];
  currentUserId: string;
  canCreate: boolean;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<typeof blank | null>(null);
  const [busy, setBusy] = useState(false);
  /** Server-side rejections, keyed by the input they belong to. */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof typeof blank, string>>>(
    {}
  );

  /** Opening, switching or closing the form drops the errors of the last one. */
  const openForm = (value: typeof blank | null) => {
    setForm(value);
    setFieldErrors({});
  };

  /** Editing a field withdraws the complaint made about it. */
  const updateForm = (patch: Partial<typeof blank>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setFieldErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof typeof blank];
      return next;
    });
  };
  /**
   * A one-time password is never returned to this screen — it goes to the
   * account holder's phone. All we learn is whether the SMS left the building,
   * and this holds the cases where it did not.
   */
  const [deliveryFailure, setDeliveryFailure] = useState<{
    id: string;
    name: string;
    recipient: string;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);

  /** Returns whether the password reached its owner, so callers can react to a repeat failure. */
  const reportDelivery = (
    account: { id: string; fullName: string },
    title: string,
    delivery: { delivered: boolean; recipient: string }
  ) => {
    if (delivery.delivered) {
      toast({ title, description: `One-time password sent by SMS to ${delivery.recipient}.` });
      setDeliveryFailure(null);
      return true;
    }
    // Why the send failed is a server-side concern: the operator's next move is
    // the same either way, and the provider's own error text is not something
    // to put on screen.
    setDeliveryFailure({ id: account.id, name: account.fullName, recipient: delivery.recipient });
    return false;
  };

  /**
   * Nothing is stored to resend — the password exists only as a hash the moment
   * it is issued. A retry therefore mints a fresh one-time password and sends
   * that, which also invalidates whatever the failed attempt generated.
   */
  const retryDelivery = async () => {
    if (!deliveryFailure) return;
    setRetrying(true);
    try {
      const response = await fetch(`/api/admin/users/${deliveryFailure.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-password' }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        toast({ variant: 'destructive', title: 'Retry failed', description: data?.error });
        return;
      }

      const sent = reportDelivery(
        { id: deliveryFailure.id, fullName: deliveryFailure.name },
        'Password sent',
        data.passwordDelivery
      );
      if (!sent) {
        toast({
          variant: 'destructive',
          title: 'Still not delivered',
          description: 'The SMS did not go out.',
        });
      }
      router.refresh();
    } finally {
      setRetrying(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFieldErrors({});
    try {
      const editing = Boolean(form.id);
      const response = await fetch(editing ? `/api/admin/users/${form.id}` : '/api/admin/users', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, providerId: form.providerId || null }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // A rejection that names a field belongs under that field. Everything
        // else - a permission refusal, a body that never arrived - has no
        // input to sit under and stays a toast.
        if (data?.field && data.field in blank) {
          setFieldErrors({ [data.field as keyof typeof blank]: String(data.error) });
        } else {
          toast({ variant: 'destructive', title: 'Save failed', description: data?.error });
        }
        return;
      }

      if (data.passwordDelivery) {
        reportDelivery(
          { id: data.id, fullName: form.fullName },
          'User created',
          data.passwordDelivery
        );
      } else {
        toast({ title: 'User updated' });
      }

      openForm(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const act = async (user: UserRow, action: string) => {
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      toast({ variant: 'destructive', title: 'Action failed', description: data?.error });
      return;
    }

    if (data.passwordDelivery) {
      reportDelivery(user, 'Password reset', data.passwordDelivery);
    } else {
      toast({ title: 'Done' });
    }
    router.refresh();
  };

  const changeStatus = async (user: UserRow, status: string) => {
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      toast({ variant: 'destructive', title: 'Update failed', description: data?.error });
      return;
    }
    toast({ title: `Account is now ${status.toLowerCase()}` });
    router.refresh();
  };

  return (
    <>
      {canCreate && (
        <div className="mb-4">
          <Button onClick={() => openForm({ ...blank, roleId: roles[0]?.id ?? '' })}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add user
          </Button>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">Contact</th>
              <th className="px-4 py-2.5 font-semibold">Role</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Last sign-in</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.length === 0 && <EmptyRow colSpan={6} message="No users yet." />}
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-secondary/30">
                <td className="px-4 py-2.5">
                  <p className="font-medium">
                    {user.fullName}
                    {user.id === currentUserId && (
                      <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                    )}
                  </p>
                  {user.passwordChangeRequired && (
                    <Badge variant="warning" className="mt-1">
                      Temp password
                    </Badge>
                  )}
                  {user.locked && (
                    <Badge variant="destructive" className="ml-1 mt-1">
                      Locked
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <p className="text-xs">{user.email}</p>
                  <p className="font-mono text-xs text-muted-foreground">{user.phoneNumber}</p>
                </td>
                <td className="px-4 py-2.5">
                  {user.roleName}
                  {user.providerName && <p className="text-xs text-muted-foreground">{user.providerName} only</p>}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={user.status} />
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {user.lastLoginAt
                    ? new Date(user.lastLoginAt).toLocaleString('en-GB')
                    : 'Never'}
                </td>
                <td className="px-4 py-2.5">
                  {canUpdate && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Edit"
                        aria-label={`Edit ${user.fullName}`}
                        onClick={() =>
                          openForm({
                            id: user.id,
                            fullName: user.fullName,
                            email: user.email,
                            phoneNumber: user.phoneNumber,
                            roleId: user.roleId,
                            providerId: user.providerId ?? '',
                            status: user.status,
                          })
                        }
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {user.id !== currentUserId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Reset password"
                          aria-label={`Reset password for ${user.fullName}`}
                          onClick={() => act(user, 'reset-password')}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {user.locked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Unlock"
                          aria-label={`Unlock ${user.fullName}`}
                          onClick={() => act(user, 'unlock')}
                        >
                          <LockOpen className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {/* Offered on every row, including the operator's own.
                          The rules that stop an account being disabled — your
                          own, and the last active Super Admin — live on the
                          server, and hiding the control here meant the only
                          person who can open this page had no way to reach the
                          Super Admin rule at all: it never fired and never
                          explained itself. The refusal is what should be seen. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className={user.status === 'ACTIVE' ? 'text-destructive' : ''}
                        onClick={() =>
                          changeStatus(user, user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')
                        }
                      >
                        {user.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <Dialog open={form !== null} onOpenChange={(open) => !open && openForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.id ? 'Edit user' : 'New user'}</DialogTitle>
            <DialogDescription>
              {form?.id
                ? 'Changing the role takes effect on the next request.'
                : "A one-time password is generated and sent to the user's phone by SMS." +
                  ' It is never shown here.'}
            </DialogDescription>
          </DialogHeader>

          {form && (
            <form onSubmit={save} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="u-name">Full name</Label>
                <Input
                  id="u-name"
                  required
                  value={form.fullName}
                  onChange={(event) => updateForm({ fullName: event.target.value })}
                  {...invalidProps('u-name-error', fieldErrors.fullName)}
                />
                <FieldError id="u-name-error" message={fieldErrors.fullName} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-email">Email</Label>
                <Input
                  id="u-email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(event) => updateForm({ email: event.target.value })}
                  {...invalidProps('u-email-error', fieldErrors.email)}
                />
                <FieldError id="u-email-error" message={fieldErrors.email} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-phone">Phone number</Label>
                <Input
                  id="u-phone"
                  required
                  value={form.phoneNumber}
                  onChange={(event) => updateForm({ phoneNumber: event.target.value })}
                  placeholder="0911223344"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  // Long enough for +251912345678 and not a character more,
                  // so an over-length entry cannot be typed in the first place.
                  maxLength={13}
                  {...invalidProps('u-phone-error', fieldErrors.phoneNumber)}
                />
                <FieldError id="u-phone-error" message={fieldErrors.phoneNumber} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-role">Role</Label>
                <select
                  id="u-role"
                  required
                  value={form.roleId}
                  onChange={(event) => updateForm({ roleId: event.target.value })}
                  aria-invalid={Boolean(fieldErrors.roleId)}
                  aria-describedby={fieldErrors.roleId ? 'u-role-error' : undefined}
                  className={
                    'h-10 w-full rounded-md border bg-background px-3 text-sm ' +
                    (fieldErrors.roleId ? 'border-destructive' : 'border-input')
                  }
                >
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <FieldError id="u-role-error" message={fieldErrors.roleId} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-provider">Provider access</Label>
                <select
                  id="u-provider"
                  value={form.providerId}
                  onChange={(event) => updateForm({ providerId: event.target.value })}
                  className={
                    'h-10 w-full rounded-md border bg-background px-3 text-sm ' +
                    (fieldErrors.providerId ? 'border-destructive' : 'border-input')
                  }
                >
                  <option value="">All providers (platform staff)</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} only
                    </option>
                  ))}
                </select>
                <FieldError id="u-provider-error" message={fieldErrors.providerId} />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => openForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deliveryFailure !== null}
        onOpenChange={(open) => !open && !retrying && setDeliveryFailure(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Password SMS not delivered
            </DialogTitle>
            <DialogDescription>
              The one-time password for {deliveryFailure?.name} could not be sent to{' '}
              {deliveryFailure?.recipient}. The account cannot be signed into until its owner has
              it.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-lg border border-border bg-secondary/50 p-3 text-sm text-muted-foreground">
            {canUpdate
              ? 'Retrying issues a new one-time password and sends that. ' +
                ''
              : '.'}
          </p>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeliveryFailure(null)}
              disabled={retrying}
            >
              Close
            </Button>
            {/* Retry goes through the password-reset endpoint, so an operator
                who may create accounts but not update them is not offered a
                button the server would refuse. */}
            {canUpdate && (
              <Button onClick={retryDelivery} disabled={retrying}>
                {retrying ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Retry
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
