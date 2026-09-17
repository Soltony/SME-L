'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button, buttonVariants, type ButtonProps } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export interface ActionField {
  name: string;
  label: string;
  type?: 'text' | 'amount' | 'number' | 'textarea' | 'select';
  placeholder?: string;
  help?: string;
  required?: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
}

/** POSTs JSON and reports the result: a toast on success, the error under its field on failure. */
export async function postJson(endpoint: string, body: unknown, method = 'POST') {
  const response = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export function ActionDialog({
  label,
  title,
  description,
  endpoint,
  method = 'POST',
  fields = [],
  extra = {},
  submitLabel = 'Submit',
  variant = 'outline',
  size = 'sm',
  destructive = false,
  disabled = false,
  icon,
  className,
}: {
  label: string;
  title: string;
  description?: string;
  endpoint: string;
  method?: string;
  fields?: ActionField[];
  extra?: Record<string, unknown>;
  submitLabel?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  destructive?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const initial = () => Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? '']));
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setValues(initial());
      setErrors({});
      setGeneral(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const { ok, data } = await postJson(endpoint, { ...extra, ...values }, method);
      if (!ok) {
        const field = typeof data?.field === 'string' ? data.field : null;
        if (field && fields.some((f) => f.name === field)) setErrors({ [field]: data.error });
        else setGeneral(data?.error || 'The request failed.');
        return;
      }
      toast({ title: data?.message || 'Done' });
      setOpen(false);
      router.refresh();
    } catch {
      setGeneral('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        className={cn(destructive && variant !== 'destructive' && 'text-destructive', className)}
        onClick={() => openChange(true)}
      >
        {icon}
        {label}
      </Button>
      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            {general && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {general}
              </p>
            )}
            {fields.map((field) => {
              const id = `f-${field.name}`;
              const error = errors[field.name];
              const common = {
                id,
                required: field.required,
                value: values[field.name] ?? '',
                placeholder: field.placeholder,
                'aria-invalid': Boolean(error),
                className: cn(error && 'border-destructive'),
              };
              const set = (value: string) => {
                setValues((v) => ({ ...v, [field.name]: value }));
                setErrors((e) => {
                  const next = { ...e };
                  delete next[field.name];
                  return next;
                });
              };
              return (
                <div key={field.name} className="space-y-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  {field.type === 'textarea' ? (
                    <Textarea {...common} rows={4} onChange={(e) => set(e.target.value)} />
                  ) : field.type === 'select' ? (
                    <select
                      {...common}
                      onChange={(e) => set(e.target.value)}
                      className={cn('h-10 w-full rounded-md border border-input bg-background px-3 text-sm', error && 'border-destructive')}
                    >
                      <option value="" disabled>
                        Choose…
                      </option>
                      {field.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      {...common}
                      type="text"
                      inputMode={field.type === 'amount' || field.type === 'number' ? 'decimal' : undefined}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                  {error ? (
                    <p className="text-xs font-medium text-destructive">{error}</p>
                  ) : field.help ? (
                    <p className="text-xs text-muted-foreground">{field.help}</p>
                  ) : null}
                </div>
              );
            })}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A one-click action with a confirmation step, asked in-app rather than through the browser. */
export function ConfirmButton({
  label,
  confirm,
  title,
  confirmLabel,
  endpoint,
  body,
  variant = 'outline',
  size = 'sm',
  destructive = false,
  disabled = false,
  icon,
}: {
  label: string;
  confirm: string;
  title?: string;
  confirmLabel?: string;
  endpoint: string;
  body: unknown;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  destructive?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { ok, data } = await postJson(endpoint, body);
      toast(ok ? { title: data?.message || 'Done' } : { variant: 'destructive', title: 'Failed', description: data?.error });
      setOpen(false);
      if (ok) router.refresh();
    } catch {
      toast({ variant: 'destructive', title: 'Failed', description: 'Network error. Please try again.' });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Button type="button" variant={variant} size={size} disabled={disabled || busy} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : icon}
        {label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? label}</AlertDialogTitle>
          <AlertDialogDescription>{confirm}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            onClick={(event) => {
              // Keep the dialog open while the request is in flight; `run` closes it.
              event.preventDefault();
              void run();
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel ?? label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
