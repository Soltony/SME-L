'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';

type Rule = { field: string; operator: string; value: string; score: string };
type Parameter = { name: string; weight: string; rules: Rule[] };

const OPERATORS = [
  { value: '>=', label: '≥' },
  { value: '>', label: '>' },
  { value: '<=', label: '≤' },
  { value: '<', label: '<' },
  { value: '==', label: '=' },
  { value: '!=', label: '≠' },
  { value: 'between', label: 'between (min,max)' },
  { value: 'in', label: 'is one of (a,b,c)' },
];

interface Preview {
  total: number;
  maxPossible: number;
  breakdown: { parameter: string; weight: number; points: number; matchedRule: string | null }[];
  values: Record<string, unknown>;
}

export function ScoringEditor({
  providerId,
  initial,
  fields,
  canSubmit,
}: {
  providerId: string;
  initial: Parameter[];
  fields: string[];
  canSubmit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [parameters, setParameters] = useState<Parameter[]>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const endpoint = `/api/admin/credit-scoring/${providerId}`;
  const updateParam = (i: number, patch: Partial<Parameter>) => setParameters(parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const updateRule = (i: number, r: number, patch: Partial<Rule>) =>
    updateParam(i, { rules: parameters[i].rules.map((rule, k) => (k === r ? { ...rule, ...patch } : rule)) });
  const errorAt = (path: string) => errors[path];

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const { ok, data } = await postJson(endpoint, { action: 'save-model', parameters });
      if (!ok) {
        const issues: { path: string; message: string }[] = data?.issues ?? [];
        setErrors(Object.fromEntries(issues.map((i) => [i.path.replace(/^parameters\./, ''), i.message])));
        toast({ variant: 'destructive', title: 'Not submitted', description: data?.error });
        return;
      }
      toast({ title: data.message });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (event: React.FormEvent) => {
    event.preventDefault();
    setPreviewing(true);
    setPreviewError(null);
    try {
      const { ok, data } = await postJson(endpoint, { action: 'preview', phone, parameters });
      if (!ok) {
        setPreview(null);
        setPreviewError(data?.issues ? 'Fix the model errors first.' : data?.error || 'Preview failed.');
        return;
      }
      setPreview(data as Preview);
    } finally {
      setPreviewing(false);
    }
  };

  const maxTotal = parameters.reduce((sum, p) => sum + (Number(p.weight) || 0), 0);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <datalist id="scoring-fields">
          {fields.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {parameters.map((parameter, i) => (
          <section key={i} className="panel p-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
                Parameter
                <Input value={parameter.name} disabled={!canSubmit} onChange={(e) => updateParam(i, { name: e.target.value })} className={errorAt(`${i}.name`) ? 'border-destructive' : ''} />
              </label>
              <label className="flex w-28 flex-col gap-1 text-xs font-medium text-muted-foreground">
                Max points
                <Input value={parameter.weight} disabled={!canSubmit} inputMode="numeric" onChange={(e) => updateParam(i, { weight: e.target.value })} />
              </label>
              {canSubmit && (
                <Button type="button" variant="ghost" size="icon" aria-label="Remove parameter" onClick={() => setParameters(parameters.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            {errorAt(`${i}.name`) && <p className="mt-1 text-xs text-destructive">{errorAt(`${i}.name`)}</p>}
            <p className="mt-2 text-xs text-muted-foreground">The best matching rule counts, up to the parameter&apos;s max points.</p>
            <div className="mt-2 space-y-2">
              {parameter.rules.map((rule, r) => (
                <div key={r}>
                  <div className="grid gap-2 md:grid-cols-[1.4fr_150px_1fr_90px_40px]">
                    <Input list="scoring-fields" aria-label="Field" placeholder="Field" value={rule.field} disabled={!canSubmit} onChange={(e) => updateRule(i, r, { field: e.target.value })} />
                    <select aria-label="Operator" value={rule.operator} disabled={!canSubmit} onChange={(e) => updateRule(i, r, { operator: e.target.value })} className="h-10 rounded-md border border-input bg-background px-2 text-sm">
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <Input aria-label="Value" placeholder="Value" value={rule.value} disabled={!canSubmit} onChange={(e) => updateRule(i, r, { value: e.target.value })} className={errorAt(`${i}.rules.${r}.value`) ? 'border-destructive' : ''} />
                    <Input aria-label="Points" placeholder="Points" value={rule.score} disabled={!canSubmit} inputMode="numeric" onChange={(e) => updateRule(i, r, { score: e.target.value })} className={errorAt(`${i}.rules.${r}.score`) ? 'border-destructive' : ''} />
                    {canSubmit && (
                      <Button type="button" variant="ghost" size="icon" aria-label="Remove rule" onClick={() => updateParam(i, { rules: parameter.rules.filter((_, k) => k !== r) })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {(errorAt(`${i}.rules.${r}.value`) || errorAt(`${i}.rules.${r}.score`) || errorAt(`${i}.rules.${r}.field`)) && (
                    <p className="text-xs text-destructive">{errorAt(`${i}.rules.${r}.value`) || errorAt(`${i}.rules.${r}.score`) || errorAt(`${i}.rules.${r}.field`)}</p>
                  )}
                </div>
              ))}
              {errorAt(`${i}.rules`) && <p className="text-xs text-destructive">{errorAt(`${i}.rules`)}</p>}
              {canSubmit && (
                <Button type="button" size="sm" variant="outline" onClick={() => updateParam(i, { rules: [...parameter.rules, { field: '', operator: '>=', value: '', score: '' }] })}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add rule
                </Button>
              )}
            </div>
          </section>
        ))}
        {canSubmit && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setParameters([...parameters, { name: '', weight: '10', rules: [{ field: '', operator: '>=', value: '', score: '' }] }])}>
              <Plus className="mr-1.5 h-4 w-4" /> Add parameter
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Highest possible score: {maxTotal}</span>
              <Button type="button" onClick={save} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit model for approval
              </Button>
            </div>
          </div>
        )}
      </div>

      <aside className="panel h-fit p-4 text-sm xl:sticky xl:top-20">
        <h2 className="font-semibold">Try it on a borrower</h2>
        <p className="mt-1 text-xs text-muted-foreground">Scores the model on screen — including unsaved edits — against a borrower&apos;s uploaded data and history.</p>
        <form onSubmit={runPreview} className="mt-3 flex gap-2">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0910000001" aria-label="Borrower phone" />
          <Button type="submit" variant="secondary" disabled={previewing}>
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>
        {previewError && <p className="mt-2 text-destructive">{previewError}</p>}
        {preview && (
          <div className="mt-3 space-y-3">
            <p className="text-2xl font-bold">
              {preview.total}
              <span className="text-sm font-normal text-muted-foreground"> / {preview.maxPossible}</span>
            </p>
            <ul className="space-y-1.5">
              {preview.breakdown.map((b) => (
                <li key={b.parameter} className="flex justify-between gap-2">
                  <span>
                    {b.parameter}
                    <span className="block text-xs text-muted-foreground">{b.matchedRule ?? 'no rule matched'}</span>
                  </span>
                  <span className="num">
                    {b.points}/{b.weight}
                  </span>
                </li>
              ))}
            </ul>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Data used</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-secondary/60 p-2 text-[11px]">{JSON.stringify(preview.values, null, 2)}</pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  );
}
