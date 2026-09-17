'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, ShieldAlert, Upload } from 'lucide-react';
import { LogoMark } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { MAX_PLATFORM_LOGO_BYTES, PLATFORM_LOGO_ERROR, PLATFORM_LOGO_MIME_TYPES } from '@/lib/platform-logo';
import { cn } from '@/lib/utils';
import { postJson } from './action-dialog';

export interface SettingField {
  key: string;
  label: string;
  description: string;
  type: 'number' | 'string' | 'boolean' | 'select' | 'image';
  sensitive: boolean;
  unit?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

type Value = string | number | boolean;

/** Number inputs hold text while being typed, so 3 and '3' must compare equal. */
function same(field: SettingField, a: Value, b: Value) {
  return field.type === 'number' ? String(a) === String(b) : a === b;
}

/**
 * Picks a brand mark and hands it back as an inline data URI, which is how the
 * setting stores it. Reads the file in the browser, so there is no upload
 * endpoint and nothing is written anywhere until the form is saved.
 */
function LogoField({
  id,
  value,
  disabled,
  onChange,
  onError,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (uri: string) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  const read = (file: File) => {
    if (!(PLATFORM_LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
      onError(PLATFORM_LOGO_ERROR);
      return;
    }
    if (file.size > MAX_PLATFORM_LOGO_BYTES) {
      onError(`That image is ${Math.ceil(file.size / 1024)} KB. The limit is ${Math.round(MAX_PLATFORM_LOGO_BYTES / 1024)} KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => onError('That image could not be read.');
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
        {value ? (
          <img src={value} alt="" aria-hidden className="h-10 w-10 object-contain" />
        ) : (
          <LogoMark className="h-9 w-9" />
        )}
      </span>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          id={id}
          type="file"
          className="hidden"
          accept={PLATFORM_LOGO_MIME_TYPES.join(',')}
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) read(file);
            // Let the same file be picked again after a failed attempt.
            event.target.value = '';
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {value ? 'Replace' : 'Upload'}
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange('')}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/** Mirrors the server's rules so a bad number is caught before the round trip. */
function checkNumber(field: SettingField, value: Value): string | null {
  const text = String(value ?? '').trim();
  if (!text) return `${field.label} is required.`;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return `${field.label} must be a whole number.`;
  if (field.min !== undefined && n < field.min) return `${field.label} must be at least ${field.min}.`;
  if (field.max !== undefined && n > field.max) return `${field.label} must be at most ${field.max}.`;
  return null;
}

export function SettingsForm({
  groups,
  values,
  canUpdate,
  approvalOn,
}: {
  groups: { label: string; fields: SettingField[] }[];
  values: Record<string, Value>;
  canUpdate: boolean;
  approvalOn: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // A saved change comes back through the server component; re-baseline the draft
  // on it so applied edits stop reading as unsaved.
  const snapshot = JSON.stringify(values);
  const [baseline, setBaseline] = useState(snapshot);
  if (snapshot !== baseline) {
    setBaseline(snapshot);
    setDraft(values);
    setErrors({});
  }

  const fields = useMemo(() => groups.flatMap((group) => group.fields), [groups]);
  const dirty = useMemo(
    () => fields.filter((field) => !same(field, draft[field.key], values[field.key])),
    [fields, draft, values]
  );

  const set = (field: SettingField, value: Value) => {
    setDraft((prev) => ({ ...prev, [field.key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field.key];
      return next;
    });
  };

  const discard = () => {
    setDraft(values);
    setErrors({});
  };

  const save = async () => {
    const found: Record<string, string> = {};
    for (const field of dirty) {
      if (field.type !== 'number') continue;
      const error = checkNumber(field, draft[field.key]);
      if (error) found[field.key] = error;
    }
    if (Object.keys(found).length) {
      setErrors(found);
      toast({ variant: 'destructive', title: 'Not saved', description: 'Some values need fixing first.' });
      return;
    }

    setBusy(true);
    setErrors({});
    try {
      const changed = Object.fromEntries(dirty.map((field) => [field.key, draft[field.key]]));
      const { ok, data } = await postJson('/api/admin/settings', { action: 'settings', values: changed });
      if (!ok) {
        if (data?.field) setErrors({ [data.field]: data.error });
        toast({ variant: 'destructive', title: 'Not saved', description: data?.error });
        return;
      }
      toast({ title: data.message });
      // Anything held for approval is not applied yet, so show the stored value again.
      setDraft(values);
      router.refresh();
    } catch {
      toast({ variant: 'destructive', title: 'Not saved', description: 'Network error. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const renderLabel = (field: SettingField, changed: boolean) => (
    <Label htmlFor={field.key} className="flex flex-wrap items-center gap-1.5">
      {field.label}
      {field.sensitive && approvalOn && (
        <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-semibold uppercase">
          Needs approval
        </Badge>
      )}
      {changed && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-semibold uppercase">
          Changed
        </Badge>
      )}
    </Label>
  );

  const renderField = (field: SettingField) => {
    const value = draft[field.key];
    const changed = !same(field, value, values[field.key]);
    const error = errors[field.key];
    const range = field.min !== undefined && field.max !== undefined ? `${field.min}–${field.max}` : null;
    // One muted line beside the input rather than a unit column plus a range row.
    const hint = [field.unit, range && `allowed ${range}`].filter(Boolean).join(' · ');

    if (field.type === 'boolean') {
      return (
        <div key={field.key} className="flex items-start justify-between gap-4 py-3">
          <div className="min-w-0">
            {renderLabel(field, changed)}
            <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>
            {error && <p className="mt-1 text-xs font-medium text-destructive">{error}</p>}
          </div>
          <Switch
            id={field.key}
            checked={Boolean(value)}
            disabled={!canUpdate}
            onCheckedChange={(checked) => set(field, checked)}
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="py-3">
        {renderLabel(field, changed)}
        <p className="mb-1.5 mt-0.5 text-xs text-muted-foreground">{field.description}</p>

        {field.type === 'image' ? (
          <LogoField
            id={field.key}
            value={String(value ?? '')}
            disabled={!canUpdate}
            onChange={(uri) => set(field, uri)}
            onError={(message) => setErrors((prev) => ({ ...prev, [field.key]: message }))}
          />
        ) : field.type === 'select' ? (
          <select
            id={field.key}
            value={String(value ?? '')}
            disabled={!canUpdate}
            onChange={(event) => set(field, event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
          >
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Input
              id={field.key}
              value={String(value ?? '')}
              disabled={!canUpdate}
              aria-invalid={Boolean(error)}
              aria-describedby={hint ? `${field.key}-hint` : undefined}
              inputMode={field.type === 'number' ? 'numeric' : undefined}
              min={field.min}
              max={field.max}
              className={cn(field.type === 'number' && 'w-32', error && 'border-destructive')}
              onChange={(event) => set(field, event.target.value)}
            />
            {hint && (
              <span id={`${field.key}-hint`} className="text-xs text-muted-foreground">
                {hint}
              </span>
            )}
          </div>
        )}

        {error && <p className="mt-1 text-xs font-medium text-destructive">{error}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {!canUpdate && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          You have read-only access to settings.
        </div>
      )}

      {/* Multi-column rather than a grid: panels vary a lot in height, and grid
          rows would leave a gap under every short one. */}
      <div className="columns-1 gap-4 xl:columns-2">
        {groups.map((group) => {
          const changedHere = group.fields.filter((field) => dirty.includes(field)).length;
          return (
            <section key={group.label} className="panel mb-4 break-inside-avoid p-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h2 className="font-semibold">{group.label}</h2>
                {changedHere > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-semibold uppercase">
                    {changedHere} changed
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {group.fields.length} setting{group.fields.length === 1 ? '' : 's'}
              </p>
              <div className="mt-1 divide-y divide-border">{group.fields.map(renderField)}</div>
            </section>
          );
        })}
      </div>

      {canUpdate && (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <span className="mr-auto text-sm text-muted-foreground">
            {dirty.length === 0
              ? 'No unsaved changes'
              : `${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}`}
          </span>
          <Button variant="outline" onClick={discard} disabled={busy || dirty.length === 0}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Discard
          </Button>
          <Button onClick={save} disabled={busy || dirty.length === 0}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
