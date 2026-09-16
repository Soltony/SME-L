'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';

export interface ProviderValues {
  code: string;
  name: string;
  colorHex: string;
  displayOrder: number | string;
  fundingAccountNo: string | null;
  nplThresholdDays: number | string;
  status: 'ACTIVE' | 'INACTIVE';
}

const EMPTY: ProviderValues = {
  code: '',
  name: '',
  colorHex: '#E0A70B',
  displayOrder: 0,
  fundingAccountNo: '',
  nplThresholdDays: 90,
  status: 'ACTIVE',
};

export function ProviderForm({
  providerId,
  initial,
  canSubmit,
}: {
  providerId?: string;
  initial?: ProviderValues;
  canSubmit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<ProviderValues>(initial ?? EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ProviderValues>(key: K, value: ProviderValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const endpoint = providerId ? `/api/admin/providers/${providerId}` : '/api/admin/providers';
      const body = { ...values, fundingAccountNo: values.fundingAccountNo || '', ...(providerId ? { action: 'update' } : {}) };
      const { ok, data } = await postJson(endpoint, body);
      if (!ok) {
        if (data?.field) setErrors({ [String(data.field)]: data.error });
        else toast({ variant: 'destructive', title: 'Not submitted', description: data?.error });
        return;
      }
      toast({ title: data.message });
      if (!providerId) setValues(EMPTY);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof ProviderValues, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, help?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`p-${key}`}>{label}</Label>
      <Input
        id={`p-${key}`}
        value={String(values[key] ?? '')}
        onChange={(e) => set(key, e.target.value as never)}
        disabled={!canSubmit}
        className={errors[key] ? 'border-destructive' : ''}
        {...props}
      />
      {errors[key] ? <p className="text-xs text-destructive">{errors[key]}</p> : help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      {field('name', 'Name', { required: true })}
      {field('code', 'Code', { required: true, placeholder: 'PRO0001' }, 'Sent to core banking with every disbursement.')}
      {field('fundingAccountNo', 'Funding account', {}, 'Core banking account the provider lends from.')}
      {field('nplThresholdDays', 'NPL threshold (days past due)', { inputMode: 'numeric' }, 'A borrower becomes non-performing at this many days past due.')}
      {field('displayOrder', 'Display order', { inputMode: 'numeric' })}
      <div className="space-y-1.5">
        <Label htmlFor="p-colorHex">Brand colour</Label>
        <div className="flex gap-2">
          <input
            type="color"
            aria-label="Pick colour"
            value={values.colorHex}
            onChange={(e) => set('colorHex', e.target.value)}
            disabled={!canSubmit}
            className="h-10 w-12 rounded border border-input"
          />
          <Input id="p-colorHex" value={values.colorHex} onChange={(e) => set('colorHex', e.target.value)} disabled={!canSubmit} />
        </div>
        {errors.colorHex && <p className="text-xs text-destructive">{errors.colorHex}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="p-status">Status</Label>
        <select
          id="p-status"
          value={values.status}
          onChange={(e) => set('status', e.target.value as ProviderValues['status'])}
          disabled={!canSubmit}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="ACTIVE">Active — lending</option>
          <option value="INACTIVE">Inactive — no new loans</option>
        </select>
      </div>
      {canSubmit && (
        <div className="flex items-end md:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {providerId ? 'Submit changes for approval' : 'Submit new provider for approval'}
          </Button>
        </div>
      )}
    </form>
  );
}
