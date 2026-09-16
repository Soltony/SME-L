'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';

export interface SettingField {
  key: string;
  label: string;
  description: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  sensitive: boolean;
  options?: { value: string; label: string }[];
}

export function SettingsForm({
  groups,
  values,
  canUpdate,
  approvalOn,
}: {
  groups: { label: string; fields: SettingField[] }[];
  values: Record<string, string | number | boolean>;
  canUpdate: boolean;
  approvalOn: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const dirty = Object.keys(draft).filter((k) => draft[k] !== values[k]);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const changed = Object.fromEntries(dirty.map((k) => [k, draft[k]]));
      const { ok, data } = await postJson('/api/admin/settings', { action: 'settings', values: changed });
      if (!ok) {
        if (data?.field) setErrors({ [data.field]: data.error });
        toast({ variant: 'destructive', title: 'Not saved', description: data?.error });
        return;
      }
      toast({ title: data.message });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.label} className="panel p-4">
          <h2 className="mb-3 font-semibold">{group.label}</h2>
          <div className="divide-y divide-border">
            {group.fields.map((field) => (
              <div key={field.key} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
                <div className="md:max-w-[60%]">
                  <p className="text-sm font-medium">
                    {field.label}
                    {field.sensitive && approvalOn && (
                      <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning-foreground">needs approval</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                  {errors[field.key] && <p className="text-xs text-destructive">{errors[field.key]}</p>}
                </div>
                <div className="md:w-64">
                  {field.type === 'boolean' ? (
                    <Switch checked={Boolean(draft[field.key])} disabled={!canUpdate} onCheckedChange={(c) => setDraft({ ...draft, [field.key]: c })} />
                  ) : field.type === 'select' ? (
                    <select
                      value={String(draft[field.key])}
                      disabled={!canUpdate}
                      onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {field.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={String(draft[field.key] ?? '')}
                      disabled={!canUpdate}
                      inputMode={field.type === 'number' ? 'numeric' : undefined}
                      onChange={(e) => setDraft({ ...draft, [field.key]: field.type === 'number' ? e.target.value : e.target.value })}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {canUpdate && (
        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <span className="text-sm text-muted-foreground">{dirty.length ? `${dirty.length} unsaved change(s)` : 'No changes'}</span>
          <Button onClick={save} disabled={busy || dirty.length === 0}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
