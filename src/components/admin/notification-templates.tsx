'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { useToast } from '@/hooks/use-toast';
import { formatDateTime } from '@/lib/format';
import {
  allowedPlaceholders,
  checkTemplateBody,
  renderTemplate,
  SAMPLE_VALUES,
  smsParts,
  TEMPLATES_BY_CODE,
} from '@/lib/notification-templates';
import { postJson } from './action-dialog';

export interface TemplateRow {
  code: string;
  name: string;
  trigger: string;
  bodyEn: string;
  bodyAm: string;
  active: boolean;
  defaultEn: string;
  defaultAm: string;
  updatedAt: string | null;
}

export function NotificationTemplates({
  templates,
  canUpdate,
  language,
  platformName,
}: {
  templates: TemplateRow[];
  canUpdate: boolean;
  /** The SMS language in Settings, so the table shows the text that actually goes out. */
  language: string;
  platformName: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const definition = editing ? TEMPLATES_BY_CODE.get(editing.code) : undefined;
  const englishProblem = editing && definition ? checkTemplateBody(definition, editing.bodyEn, 'The English message') : null;
  const amharicProblem =
    editing && definition && editing.bodyAm.trim() ? checkTemplateBody(definition, editing.bodyAm, 'The Amharic message') : null;
  const isDefault = editing ? editing.bodyEn.trim() === editing.defaultEn && editing.bodyAm.trim() === editing.defaultAm : true;

  const patch = (code: string, body: Record<string, unknown>) =>
    postJson(`/api/admin/notifications/${encodeURIComponent(code)}`, body, 'PATCH');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || englishProblem || amharicProblem) return;
    setBusy(true);
    try {
      const { ok, data } = await patch(editing.code, { bodyEn: editing.bodyEn, bodyAm: editing.bodyAm });
      if (!ok) {
        toast({ variant: 'destructive', title: 'Not saved', description: data?.error });
        return;
      }
      toast({ title: data.message });
      setEditing(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (template: TemplateRow, active: boolean) => {
    setToggling(template.code);
    try {
      const { ok, data } = await patch(template.code, { active });
      if (!ok) {
        toast({ variant: 'destructive', title: 'Not changed', description: data?.error });
        return;
      }
      toast({ title: data.message });
      router.refresh();
    } finally {
      setToggling(null);
    }
  };

  const samples = { ...SAMPLE_VALUES, platform: platformName };

  return (
    <>
      <TableCard>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Message</th>
              <th className="px-4 py-2.5 font-semibold">Sent when</th>
              <th className="px-4 py-2.5 font-semibold">Wording ({language === 'am' ? 'Amharic' : 'English'})</th>
              <th className="px-4 py-2.5 font-semibold">On</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {templates.length === 0 && <EmptyRow colSpan={5} message="No messages defined." />}
            {templates.map((template) => {
              const amharicMissing = language === 'am' && !template.bodyAm.trim();
              const shown = language === 'am' && !amharicMissing ? template.bodyAm : template.bodyEn;
              const edited = template.bodyEn !== template.defaultEn || template.bodyAm !== template.defaultAm;
              return (
                <tr key={template.code} className={template.active ? 'align-top' : 'align-top opacity-60'}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{template.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{template.code}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {edited && (
                        <Badge variant="secondary" title={template.updatedAt ? `Edited ${formatDateTime(template.updatedAt)}` : undefined}>
                          Edited
                        </Badge>
                      )}
                      {amharicMissing && <Badge variant="warning">No Amharic — sends English</Badge>}
                    </div>
                  </td>
                  <td className="max-w-[240px] px-4 py-2.5 text-xs text-muted-foreground">{template.trigger}</td>
                  <td className="max-w-[380px] px-4 py-2.5 text-xs">
                    <p className="line-clamp-3">{shown}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <Switch
                      checked={template.active}
                      disabled={!canUpdate || toggling === template.code}
                      onCheckedChange={(checked) => toggle(template, checked)}
                      aria-label={`Send ${template.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canUpdate && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(template)} aria-label={`Edit ${template.name}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.name}</DialogTitle>
            <DialogDescription>{editing?.trigger}</DialogDescription>
          </DialogHeader>

          {editing && definition && (
            <form onSubmit={save} className="space-y-4">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Placeholders:
                {allowedPlaceholders(definition).map((name) => (
                  <code key={name} className="rounded bg-secondary px-1.5 py-0.5 text-foreground">{`{${name}}`}</code>
                ))}
              </div>

              <BodyField
                id="template-en"
                label="English"
                value={editing.bodyEn}
                onChange={(bodyEn) => setEditing({ ...editing, bodyEn })}
                problem={englishProblem}
                preview={renderTemplate(editing.bodyEn, samples)}
                required
              />
              <BodyField
                id="template-am"
                label="Amharic"
                hint="Leave empty to send the English text when the SMS language is Amharic."
                value={editing.bodyAm}
                onChange={(bodyAm) => setEditing({ ...editing, bodyAm })}
                problem={amharicProblem}
                preview={editing.bodyAm.trim() ? renderTemplate(editing.bodyAm, samples) : ''}
              />

              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isDefault}
                  onClick={() => setEditing({ ...editing, bodyEn: editing.defaultEn, bodyAm: editing.defaultAm })}
                >
                  Use default wording
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy || Boolean(englishProblem || amharicProblem)}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save
                  </Button>
                </div>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BodyField({
  id,
  label,
  hint,
  value,
  onChange,
  problem,
  preview,
  required = false,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  preview: string;
  required?: boolean;
}) {
  const size = smsParts(preview);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={3} required={required} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {preview && !problem && (
        <div className="rounded-md border border-border bg-secondary/40 p-2.5 text-xs">
          <p className="mb-1 flex flex-wrap justify-between gap-2 text-muted-foreground">
            <span>Preview with example values</span>
            <span>
              {size.chars} characters · about {size.parts} SMS {size.parts === 1 ? 'part' : 'parts'}
            </span>
          </p>
          <p className="whitespace-pre-wrap">{preview}</p>
        </div>
      )}
    </div>
  );
}
