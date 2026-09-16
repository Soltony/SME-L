'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { ProviderIcon, PROVIDER_ICONS } from '@/components/provider-icon';
import {
  DEFAULT_PROVIDER_ICON,
  isUploadedIcon,
  MAX_PROVIDER_ICON_BYTES,
  PROVIDER_ICON_MIME_TYPES,
  PROVIDER_ICON_NAMES,
} from '@/lib/provider-icon';
import { postJson } from './action-dialog';

export interface ProviderValues {
  code: string;
  name: string;
  colorHex: string;
  icon: string;
  displayOrder: number | string;
  fundingAccountNo: string | null;
  collectionAccountNo: string | null;
  nplThresholdDays: number | string;
  status: 'ACTIVE' | 'INACTIVE';
}

const EMPTY: ProviderValues = {
  code: '',
  name: '',
  colorHex: '#E0A70B',
  icon: DEFAULT_PROVIDER_ICON,
  displayOrder: 0,
  fundingAccountNo: '',
  collectionAccountNo: '',
  nplThresholdDays: 90,
  status: 'ACTIVE',
};

const MAX_ICON_KB = Math.round(MAX_PROVIDER_ICON_BYTES / 1024);

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
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof ProviderValues>(key: K, value: ProviderValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  /**
   * Turns the chosen file into the data URI that gets stored. Refused here for
   * the immediate message; the server applies the same rules again, because
   * nothing a browser sends can be taken on trust.
   */
  const uploadIcon = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(PROVIDER_ICON_MIME_TYPES as readonly string[]).includes(file.type)) {
      setErrors((e) => ({ ...e, icon: 'Use a PNG, JPG, WEBP or SVG file.' }));
      return;
    }
    if (file.size > MAX_PROVIDER_ICON_BYTES) {
      setErrors((e) => ({ ...e, icon: `That image is ${Math.ceil(file.size / 1024)} KB. The limit is ${MAX_ICON_KB} KB.` }));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setErrors((e) => ({ ...e, icon: 'That image could not be read.' }));
    reader.onload = () => set('icon', String(reader.result));
    reader.readAsDataURL(file);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const endpoint = providerId ? `/api/admin/providers/${providerId}` : '/api/admin/providers';
      const body = {
        ...values,
        fundingAccountNo: values.fundingAccountNo || '',
        collectionAccountNo: values.collectionAccountNo || '',
        ...(providerId ? { action: 'update' } : {}),
      };
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
      {field('collectionAccountNo', 'Collection account', {}, 'Core banking account repayments are collected into.')}
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

      <fieldset className="space-y-1.5 md:col-span-2">
        <legend className="mb-1.5 text-sm font-medium leading-none">Icon</legend>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_ICON_NAMES.map((name) => {
            const Icon = PROVIDER_ICONS[name];
            const selected = values.icon === name;
            return (
              <button
                key={name}
                type="button"
                aria-label={name}
                aria-pressed={selected}
                onClick={() => set('icon', name)}
                disabled={!canSubmit}
                className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-lg border border-input bg-background transition hover:bg-secondary disabled:opacity-50',
                  selected && 'border-primary ring-2 ring-primary/40'
                )}
                style={selected ? { color: values.colorHex } : undefined}
              >
                <Icon className="h-5 w-5" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={!canSubmit}
            aria-label="Upload an icon"
            aria-pressed={isUploadedIcon(values.icon)}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-input bg-background transition hover:bg-secondary disabled:opacity-50',
              isUploadedIcon(values.icon) && 'border-solid border-primary ring-2 ring-primary/40'
            )}
          >
            {isUploadedIcon(values.icon) ? (
              <ProviderIcon icon={values.icon} className="h-6 w-6" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
          </button>
          <input ref={fileInput} type="file" className="hidden" accept={PROVIDER_ICON_MIME_TYPES.join(',')} onChange={uploadIcon} />
        </div>
        {errors.icon ? (
          <p className="text-xs text-destructive">{errors.icon}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Shown beside the provider everywhere, borrowers included. Pick one above, or upload your own logo — PNG, JPG, WEBP or SVG, up to {MAX_ICON_KB} KB.
          </p>
        )}
      </fieldset>

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
