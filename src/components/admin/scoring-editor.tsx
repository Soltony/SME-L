'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { normalizeFieldName } from '@/lib/lending/scoring';
import { findField, OPERATORS_BY_TYPE, type ScoringField } from '@/lib/lending/scoring-fields';
import { postJson } from './action-dialog';

type Rule = { operator: string; value: string; score: string };
type Parameter = { field: string; weight: string; rules: Rule[] };

const OPERATOR_LABELS: Record<string, { number: string; text: string }> = {
  '>=': { number: 'at least', text: 'at least' },
  '>': { number: 'more than', text: 'more than' },
  '<=': { number: 'at most', text: 'at most' },
  '<': { number: 'less than', text: 'less than' },
  between: { number: 'between', text: 'between' },
  '==': { number: 'exactly', text: 'is' },
  '!=': { number: 'not', text: 'is not' },
  in: { number: 'is one of', text: 'is one of' },
};

const SELECT = 'h-10 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60';

interface Preview {
  total: number;
  maxPossible: number;
  breakdown: { parameter: string; weight: number; points: number; matchedRule: string | null }[];
  values: Record<string, unknown>;
}

function newRule(field: ScoringField | undefined): Rule {
  return { operator: field?.type === 'text' ? '==' : '>=', value: '', score: '' };
}

/** The value box for one rule, shaped by the field's type and the operator. */
function RuleValue({
  field,
  rule,
  disabled,
  invalid,
  onChange,
}: {
  field: ScoringField | undefined;
  rule: Rule;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const border = invalid ? 'border-destructive' : '';

  if (rule.operator === 'between') {
    const [min = '', max = ''] = rule.value.split(/,|\.\./);
    return (
      <div className="flex items-center gap-1.5">
        <Input aria-label="From" placeholder="from" inputMode="decimal" value={min} disabled={disabled} onChange={(e) => onChange(`${e.target.value},${max}`)} className={border} />
        <span className="text-xs text-muted-foreground">and</span>
        <Input aria-label="To" placeholder="to" inputMode="decimal" value={max} disabled={disabled} onChange={(e) => onChange(`${min},${e.target.value}`)} className={border} />
      </div>
    );
  }

  const options = field?.options ?? [];
  if (field?.type === 'text' && options.length > 0) {
    if (rule.operator === 'in') {
      const chosen = new Set(rule.value.split(',').map((v) => v.trim()).filter(Boolean));
      const all = [...options, ...[...chosen].filter((v) => !options.some((o) => o.toLowerCase() === v.toLowerCase()))];
      return (
        <div className={cn('flex flex-wrap gap-1.5 rounded-md border border-input p-1.5', border)}>
          {all.map((option) => {
            const on = [...chosen].some((v) => v.toLowerCase() === option.toLowerCase());
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => {
                  const next = on ? [...chosen].filter((v) => v.toLowerCase() !== option.toLowerCase()) : [...chosen, option];
                  onChange(next.join(','));
                }}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-xs',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-secondary'
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      );
    }
    const known = options.some((o) => o.toLowerCase() === rule.value.toLowerCase());
    return (
      <select aria-label="Value" value={rule.value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, border)}>
        <option value="">Choose…</option>
        {!known && rule.value && <option value={rule.value}>{rule.value}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label="Value"
        placeholder={rule.operator === 'in' ? 'a, b, c' : 'Value'}
        inputMode={field?.type === 'number' ? 'decimal' : undefined}
        value={rule.value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={border}
      />
      {field?.unit && <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>}
    </div>
  );
}

export function ScoringEditor({
  providerId,
  initial,
  catalogue,
  bankSimulated,
  wasSplit,
  canSubmit,
}: {
  providerId: string;
  initial: Parameter[];
  catalogue: ScoringField[];
  bankSimulated: boolean;
  wasSplit: boolean;
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
  const groups = [...new Set(catalogue.map((f) => f.group))];
  const updateParam = (i: number, patch: Partial<Parameter>) => setParameters(parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const updateRule = (i: number, r: number, patch: Partial<Rule>) =>
    updateParam(i, { rules: parameters[i].rules.map((rule, k) => (k === r ? { ...rule, ...patch } : rule)) });
  const errorAt = (path: string) => errors[path];

  /** Picking a field keeps rules that still make sense for its type and resets the rest. */
  const chooseField = (i: number, key: string) => {
    const field = findField(catalogue, key);
    const fits = (rule: Rule) => field && (OPERATORS_BY_TYPE[field.type] as string[]).includes(rule.operator);
    updateParam(i, {
      field: key,
      rules: parameters[i].rules.map((rule) => (fits(rule) ? rule : { ...newRule(field), score: rule.score })),
    });
  };

  const toPayload = () => parameters.map((p) => ({ field: p.field, weight: p.weight, rules: p.rules }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const { ok, data } = await postJson(endpoint, { action: 'save-model', parameters: toPayload() });
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
      const { ok, data } = await postJson(endpoint, { action: 'preview', phone, parameters: toPayload() });
      if (!ok) {
        setPreview(null);
        setPreviewError(data?.issues ? 'Complete every parameter and rule first.' : data?.error || 'Preview failed.');
        return;
      }
      setPreview(data as Preview);
    } finally {
      setPreviewing(false);
    }
  };

  const maxTotal = parameters.reduce((sum, p) => sum + (Number(p.weight) || 0), 0);
  const used = new Set(parameters.map((p) => normalizeFieldName(p.field)));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        {wasSplit && (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              Each parameter now scores one field. A saved parameter that mixed several fields is shown split, each part weighted at its best rule. Check the
              weights before submitting — the highest possible score may have changed.
            </span>
          </div>
        )}
        {parameters.map((parameter, i) => {
          const field = findField(catalogue, parameter.field);
          return (
            <section key={i} className="panel p-4">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Parameter
                  <select
                    value={field?.key ?? parameter.field}
                    disabled={!canSubmit}
                    onChange={(e) => chooseField(i, e.target.value)}
                    className={cn(SELECT, 'text-foreground', errorAt(`${i}.field`) && 'border-destructive')}
                  >
                    <option value="">Choose a parameter…</option>
                    {!field && parameter.field && <option value={parameter.field}>{parameter.field} (no longer available)</option>}
                    {groups.map((group) => (
                      <optgroup key={group} label={group}>
                        {catalogue
                          .filter((f) => f.group === group)
                          .map((f) => (
                            <option key={f.key} value={f.key} disabled={used.has(normalizeFieldName(f.key)) && normalizeFieldName(f.key) !== normalizeFieldName(parameter.field)}>
                              {f.label}
                              {f.unit ? ` (${f.unit})` : ''}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
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
              {errorAt(`${i}.field`) ? (
                <p className="mt-1 text-xs text-destructive">{errorAt(`${i}.field`)}</p>
              ) : field ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {field.group} · {field.type === 'number' ? 'number' : 'text'}
                  {field.help ? ` · ${field.help}` : ''}
                </p>
              ) : null}

              {field && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">If several rules match, the one worth the most points counts, up to the parameter&apos;s max.</p>
                  {parameter.rules.map((rule, r) => {
                    const ruleError = errorAt(`${i}.rules.${r}.value`) || errorAt(`${i}.rules.${r}.score`) || errorAt(`${i}.rules.${r}.operator`);
                    return (
                      <div key={r}>
                        <div className="grid items-start gap-2 md:grid-cols-[140px_1fr_90px_40px]">
                          <select
                            aria-label="Condition"
                            value={rule.operator}
                            disabled={!canSubmit}
                            onChange={(e) => updateRule(i, r, { operator: e.target.value, value: '' })}
                            className={cn(SELECT, errorAt(`${i}.rules.${r}.operator`) && 'border-destructive')}
                          >
                            {!(OPERATORS_BY_TYPE[field.type] as string[]).includes(rule.operator) && <option value={rule.operator}>{rule.operator}</option>}
                            {OPERATORS_BY_TYPE[field.type].map((op) => (
                              <option key={op} value={op}>
                                {OPERATOR_LABELS[op][field.type]}
                              </option>
                            ))}
                          </select>
                          <RuleValue field={field} rule={rule} disabled={!canSubmit} invalid={Boolean(errorAt(`${i}.rules.${r}.value`))} onChange={(value) => updateRule(i, r, { value })} />
                          <Input
                            aria-label="Points"
                            placeholder="Points"
                            value={rule.score}
                            disabled={!canSubmit}
                            inputMode="numeric"
                            onChange={(e) => updateRule(i, r, { score: e.target.value })}
                            className={errorAt(`${i}.rules.${r}.score`) ? 'border-destructive' : ''}
                          />
                          {canSubmit && (
                            <Button type="button" variant="ghost" size="icon" aria-label="Remove rule" onClick={() => updateParam(i, { rules: parameter.rules.filter((_, k) => k !== r) })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                        {ruleError && <p className="text-xs text-destructive">{ruleError}</p>}
                      </div>
                    );
                  })}
                  {errorAt(`${i}.rules`) && <p className="text-xs text-destructive">{errorAt(`${i}.rules`)}</p>}
                  {canSubmit && (
                    <Button type="button" size="sm" variant="outline" onClick={() => updateParam(i, { rules: [...parameter.rules, newRule(field)] })}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add rule
                    </Button>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {canSubmit && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setParameters([...parameters, { field: '', weight: '10', rules: [newRule(undefined)] }])}>
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
        <p className="mt-1 text-xs text-muted-foreground">
          Scores the model on screen — including unsaved edits — against a borrower&apos;s core banking figures, uploaded data and history.
          {bankSimulated && ' Core banking is simulated here, so its figures are sample values.'}
        </p>
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
              {preview.breakdown.map((b, index) => {
                const field = findField(catalogue, parameters[index]?.field ?? '');
                const value = field ? preview.values[normalizeFieldName(field.key)] : undefined;
                return (
                  <li key={b.parameter} className="flex justify-between gap-2">
                    <span>
                      {field?.label ?? b.parameter}
                      <span className="block text-xs text-muted-foreground">
                        {value === undefined || value === null || value === '' ? 'no value for this borrower' : `value ${String(value)}${field?.unit ? ` ${field.unit}` : ''}`}
                        {' · '}
                        {b.matchedRule ? 'matched' : 'no rule matched'}
                      </span>
                    </span>
                    <span className="num">
                      {b.points}/{b.weight}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
