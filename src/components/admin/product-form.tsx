'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { postJson } from './action-dialog';

import type { DocRow, FilterRow, PenaltyRow, ProductFormValues, StepRow } from './product-form-values';

export type { ProductFormValues };

function Field({ label, error, help, children }: { label: string; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

const SELECT = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

function toPayload(v: ProductFormValues) {
  return {
    providerId: v.providerId,
    code: v.code.trim().toUpperCase(),
    name: v.name,
    description: v.description,
    minAmount: v.minAmount,
    maxAmount: v.maxAmount,
    durationDays: v.durationDays,
    installmentCount: v.installmentCount,
    serviceFeeType: v.serviceFeeType,
    serviceFeeValue: v.serviceFeeType === 'NONE' ? '0' : v.serviceFeeValue,
    interestType: v.interestType,
    interestValue: v.interestType === 'NONE' ? '0' : v.interestValue,
    interestBasis: v.interestBasis,
    accrueInterestAfterMaturity: v.accrueInterestAfterMaturity,
    penaltyRules: v.penaltyRules.map((r) => ({ ...r, toDay: r.toDay.trim() === '' ? null : r.toDay })),
    allowConcurrentLoans: v.allowConcurrentLoans,
    requiresReview: v.requiresReview,
    requiresScoring: v.requiresScoring,
    requiredDocuments: v.requiredDocuments.filter((d) => d.key || d.name),
    eligibilityFilter: v.eligibilityFilter.length
      ? Object.fromEntries(v.eligibilityFilter.filter((f) => f.field.trim()).map((f) => [f.field.trim(), f.values]))
      : null,
    cycleConfig: v.cycleEnabled ? { enabled: true, metric: v.cycleMetric, steps: v.cycleSteps } : null,
  };
}

export function ProductForm({
  productId,
  initial,
  providers,
  canSubmit,
}: {
  productId?: string;
  initial: ProductFormValues;
  providers: { id: string; name: string }[];
  canSubmit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [v, setV] = useState<ProductFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) => setV((s) => ({ ...s, [key]: value }));
  const err = (path: string) => errors[path];
  const cls = (path: string) => cn(err(path) && 'border-destructive');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const payload = toPayload(v);
      const { ok, data } = productId
        ? await postJson(`/api/admin/products/${productId}`, { action: 'update', ...payload })
        : await postJson('/api/admin/products', payload);
      if (!ok) {
        const issues: { path: string; message: string }[] = data?.issues ?? (data?.field ? [{ path: data.field, message: data.error }] : []);
        if (issues.length) {
          setErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
          setGeneral('Some fields need attention.');
        } else {
          setGeneral(data?.error || 'Not submitted.');
        }
        return;
      }
      toast({ title: data.message });
      router.push('/admin/approvals');
    } finally {
      setBusy(false);
    }
  };


  return (
    <form onSubmit={submit} className="space-y-6">
      {general && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{general}</p>}
      <fieldset disabled={!canSubmit} className="space-y-6">
        <section className="panel grid gap-4 p-4 md:grid-cols-2">
          <h2 className="font-semibold md:col-span-2">Product</h2>
          <Field error={err('providerId')} label="Provider">
            <select value={v.providerId} onChange={(e) => set('providerId', e.target.value)} disabled={Boolean(productId)} className={SELECT}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field error={err('code')} label="Code" help="Short and unique within the provider, e.g. WC30.">
            <Input value={v.code} onChange={(e) => set('code', e.target.value)} className={cls('code')} required />
          </Field>
          <Field error={err('name')} label="Name">
            <Input value={v.name} onChange={(e) => set('name', e.target.value)} className={cls('name')} required />
          </Field>
          <div className="md:col-span-2">
            <Field error={err('description')} label="Description shown to borrowers">
              <Textarea value={v.description} onChange={(e) => set('description', e.target.value)} rows={2} />
            </Field>
          </div>
        </section>

        <section className="panel grid gap-4 p-4 md:grid-cols-4">
          <h2 className="font-semibold md:col-span-4">Amount and term</h2>
          <Field error={err('minAmount')} label="Minimum amount">
            <Input value={v.minAmount} onChange={(e) => set('minAmount', e.target.value)} className={cls('minAmount')} inputMode="decimal" />
          </Field>
          <Field error={err('maxAmount')} label="Maximum amount">
            <Input value={v.maxAmount} onChange={(e) => set('maxAmount', e.target.value)} className={cls('maxAmount')} inputMode="decimal" />
          </Field>
          <Field error={err('durationDays')} label="Term (days)">
            <Input value={v.durationDays} onChange={(e) => set('durationDays', e.target.value)} className={cls('durationDays')} inputMode="numeric" />
          </Field>
          <Field error={err('installmentCount')} label="Installments" help="1 = repay everything at maturity.">
            <Input value={v.installmentCount} onChange={(e) => set('installmentCount', e.target.value)} className={cls('installmentCount')} inputMode="numeric" />
          </Field>
        </section>

        <section className="panel grid gap-4 p-4 md:grid-cols-4">
          <h2 className="font-semibold md:col-span-4">Charges</h2>
          <Field error={err('serviceFeeType')} label="Service fee">
            <select value={v.serviceFeeType} onChange={(e) => set('serviceFeeType', e.target.value)} className={SELECT}>
              <option value="NONE">None</option>
              <option value="PERCENT">% of principal, once</option>
              <option value="FIXED">Fixed amount, once</option>
            </select>
          </Field>
          <Field error={err('serviceFeeValue')} label={v.serviceFeeType === 'PERCENT' ? 'Fee (%)' : 'Fee amount'}>
            <Input value={v.serviceFeeValue} onChange={(e) => set('serviceFeeValue', e.target.value)} disabled={v.serviceFeeType === 'NONE'} className={cls('serviceFeeValue')} inputMode="decimal" />
          </Field>
          <Field error={err('interestType')} label="Daily interest">
            <select value={v.interestType} onChange={(e) => set('interestType', e.target.value)} className={SELECT}>
              <option value="NONE">None</option>
              <option value="PERCENT_DAILY">% of balance per day</option>
              <option value="FIXED_DAILY">Fixed amount per day</option>
            </select>
          </Field>
          <Field error={err('interestValue')} label={v.interestType === 'PERCENT_DAILY' ? 'Rate per day (%)' : 'Amount per day'}>
            <Input value={v.interestValue} onChange={(e) => set('interestValue', e.target.value)} disabled={v.interestType === 'NONE'} className={cls('interestValue')} inputMode="decimal" />
          </Field>
          {v.interestType === 'PERCENT_DAILY' && (
            <Field error={err('interestBasis')} label="Interest base">
              <select value={v.interestBasis} onChange={(e) => set('interestBasis', e.target.value)} className={SELECT}>
                <option value="SIMPLE">Outstanding principal</option>
                <option value="COMPOUND">Principal + unpaid interest</option>
              </select>
            </Field>
          )}
          {v.interestType !== 'NONE' && (
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <Switch checked={v.accrueInterestAfterMaturity} onCheckedChange={(c) => set('accrueInterestAfterMaturity', c)} />
              Keep charging interest after maturity (otherwise only penalties apply once overdue)
            </label>
          )}
          <p className="text-xs text-muted-foreground md:col-span-4">
            Interest is charged for each completed day. Taxes configured in Settings are added on top, per charge. Changes apply to new loans
            only — every loan keeps the terms it was issued with.
          </p>
        </section>

        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Penalties</h2>
            <Button type="button" size="sm" variant="outline" onClick={() => set('penaltyRules', [...v.penaltyRules, { fromDay: '1', toDay: '', type: 'FIXED', value: '0', frequency: 'DAILY' }])}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add rule
            </Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Day 1 is the day after an installment falls due. Rules are charged per overdue installment; a blank last day runs until it is paid.
          </p>
          {v.penaltyRules.length === 0 && <p className="text-sm text-muted-foreground">No penalties.</p>}
          <div className="space-y-2">
            {v.penaltyRules.map((rule, i) => {
              const update = (patch: Partial<PenaltyRow>) =>
                set('penaltyRules', v.penaltyRules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              return (
                <div key={i} className="grid items-start gap-2 rounded-lg border border-border p-2 md:grid-cols-[90px_90px_1fr_110px_120px_40px]">
                  <div>
                    <Input aria-label="From day" value={rule.fromDay} onChange={(e) => update({ fromDay: e.target.value })} className={cls(`penaltyRules.${i}.fromDay`)} placeholder="From day" />
                    {err(`penaltyRules.${i}.fromDay`) && <p className="text-xs text-destructive">{err(`penaltyRules.${i}.fromDay`)}</p>}
                  </div>
                  <div>
                    <Input aria-label="To day" value={rule.toDay} onChange={(e) => update({ toDay: e.target.value })} className={cls(`penaltyRules.${i}.toDay`)} placeholder="To day" />
                    {err(`penaltyRules.${i}.toDay`) && <p className="text-xs text-destructive">{err(`penaltyRules.${i}.toDay`)}</p>}
                  </div>
                  <select aria-label="Type" value={rule.type} onChange={(e) => update({ type: e.target.value })} className={SELECT}>
                    <option value="FIXED">Fixed amount</option>
                    <option value="PERCENT_PRINCIPAL">% of overdue principal</option>
                    <option value="PERCENT_BALANCE">% of overdue principal + unpaid penalty</option>
                  </select>
                  <div>
                    <Input aria-label="Value" value={rule.value} onChange={(e) => update({ value: e.target.value })} className={cls(`penaltyRules.${i}.value`)} placeholder="Value" />
                    {err(`penaltyRules.${i}.value`) && <p className="text-xs text-destructive">{err(`penaltyRules.${i}.value`)}</p>}
                  </div>
                  <select aria-label="Frequency" value={rule.frequency} onChange={(e) => update({ frequency: e.target.value })} className={SELECT}>
                    <option value="DAILY">Every day</option>
                    <option value="ONCE">Once, on the first day</option>
                  </select>
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove rule" onClick={() => set('penaltyRules', v.penaltyRules.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel grid gap-4 p-4 md:grid-cols-3">
          <h2 className="font-semibold md:col-span-3">Rules</h2>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={v.requiresScoring} onCheckedChange={(c) => set('requiresScoring', c)} />
            <span>
              Use the provider&apos;s credit score
              <span className="block text-xs text-muted-foreground">The amount tier table caps each borrower.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={v.requiresReview} onCheckedChange={(c) => set('requiresReview', c)} />
            <span>
              Loan officer reviews each application
              <span className="block text-xs text-muted-foreground">Otherwise eligible applications disburse at once.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={v.allowConcurrentLoans} onCheckedChange={(c) => set('allowConcurrentLoans', c)} />
            <span>
              Can run alongside other loans
              <span className="block text-xs text-muted-foreground">Off means the borrower must have no other open loan.</span>
            </span>
          </label>
        </section>

        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Required documents</h2>
            <Button type="button" size="sm" variant="outline" onClick={() => set('requiredDocuments', [...v.requiredDocuments, { key: '', name: '' }])}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add document
            </Button>
          </div>
          {v.requiredDocuments.length === 0 && <p className="text-sm text-muted-foreground">None. Only asked for when the product is reviewed.</p>}
          <div className="space-y-2">
            {v.requiredDocuments.map((doc, i) => (
              <div key={i} className="grid gap-2 md:grid-cols-[200px_1fr_40px]">
                <div>
                  <Input aria-label="Key" placeholder="business_licence" value={doc.key} onChange={(e) => set('requiredDocuments', v.requiredDocuments.map((d, j) => (j === i ? { ...d, key: e.target.value } : d)))} className={cls(`requiredDocuments.${i}.key`)} />
                  {err(`requiredDocuments.${i}.key`) && <p className="text-xs text-destructive">{err(`requiredDocuments.${i}.key`)}</p>}
                </div>
                <Input aria-label="Name" placeholder="Business licence" value={doc.name} onChange={(e) => set('requiredDocuments', v.requiredDocuments.map((d, j) => (j === i ? { ...d, name: e.target.value } : d)))} />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove document" onClick={() => set('requiredDocuments', v.requiredDocuments.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Eligibility filter</h2>
            <Button type="button" size="sm" variant="outline" onClick={() => set('eligibilityFilter', [...v.eligibilityFilter, { field: '', values: '' }])}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add condition
            </Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">Only borrowers whose uploaded data matches one of the listed values may apply (e.g. Sector: Retail, Food).</p>
          <div className="space-y-2">
            {v.eligibilityFilter.map((row, i) => (
              <div key={i} className="grid gap-2 md:grid-cols-[200px_1fr_40px]">
                <Input aria-label="Field" placeholder="Sector" value={row.field} onChange={(e) => set('eligibilityFilter', v.eligibilityFilter.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))} />
                <Input aria-label="Allowed values" placeholder="Retail, Food" value={row.values} onChange={(e) => set('eligibilityFilter', v.eligibilityFilter.map((r, j) => (j === i ? { ...r, values: e.target.value } : r)))} />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove condition" onClick={() => set('eligibilityFilter', v.eligibilityFilter.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-4">
          <label className="flex items-center gap-2 font-semibold">
            <Switch checked={v.cycleEnabled} onCheckedChange={(c) => set('cycleEnabled', c)} />
            Loan cycles
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            New borrowers get a share of their tier amount, rising as they repay loans. The step with the highest loan count the borrower has reached applies.
          </p>
          {v.cycleEnabled && (
            <div className="mt-3 space-y-2">
              <select value={v.cycleMetric} onChange={(e) => set('cycleMetric', e.target.value)} className={cn(SELECT, 'md:w-80')}>
                <option value="PAID_OFF_LOANS">Count loans repaid in full</option>
                <option value="ON_TIME_LOANS">Count loans repaid on time</option>
              </select>
              {v.cycleSteps.map((step, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[180px_180px_40px]">
                  <Input aria-label="Loans repaid" value={step.minCount} onChange={(e) => set('cycleSteps', v.cycleSteps.map((s, j) => (j === i ? { ...s, minCount: e.target.value } : s)))} placeholder="Loans repaid" />
                  <Input aria-label="Percent of tier" value={step.percent} onChange={(e) => set('cycleSteps', v.cycleSteps.map((s, j) => (j === i ? { ...s, percent: e.target.value } : s)))} placeholder="% of tier" />
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove step" onClick={() => set('cycleSteps', v.cycleSteps.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {Object.entries(errors)
                .filter(([k]) => k.startsWith('cycleConfig'))
                .map(([k, m]) => (
                  <p key={k} className="text-xs text-destructive">
                    {m}
                  </p>
                ))}
              <Button type="button" size="sm" variant="outline" onClick={() => set('cycleSteps', [...v.cycleSteps, { minCount: '', percent: '' }])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add step
              </Button>
            </div>
          )}
        </section>
      </fieldset>

      {canSubmit && (
        <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {productId ? 'Submit changes for approval' : 'Submit product for approval'}
          </Button>
        </div>
      )}
    </form>
  );
}
