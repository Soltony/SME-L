'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calculator, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { postJson } from './action-dialog';
import { money } from '@/components/money';
import { toCents, type Cents } from '@/lib/money';
import { tierAmountIssues, tiersSchema } from '@/lib/lending/scoring';

type Tier = { minScore: string; maxScore: string; maxAmount: string };

/** Every problem with a tier table, keyed "row.field", from the same rules the server applies. */
function tierErrors(tiers: Tier[], productMax: Cents): Record<string, string> {
  const out: Record<string, string> = {};
  const parsed = tiersSchema.safeParse(tiers);
  const issues = [...(parsed.success ? [] : parsed.error.issues), ...tierAmountIssues(tiers, productMax)];
  for (const issue of issues) {
    const key = issue.path.join('.');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

const filled = (tier: Tier) => Boolean(tier.minScore.trim() && tier.maxScore.trim() && tier.maxAmount.trim());

export function TierEditor({
  productId,
  initial,
  productMax,
  canSubmit,
}: {
  productId: string;
  initial: Tier[];
  /** The product's stored maximum, as a decimal string; no tier may offer more. */
  productMax: string;
  canSubmit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [tiers, setTiers] = useState<Tier[]>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  // Until the first submit, a row still being typed is not complained about.
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const maxCents = toCents(productMax);
  const checked = tierErrors(tiers, maxCents);
  const rowOf = (key: string) => tiers[Number(key.split('.')[0])];
  const shown = attempted ? checked : Object.fromEntries(Object.entries(checked).filter(([key]) => rowOf(key) && filled(rowOf(key))));
  const errors = { ...serverErrors, ...shown };

  const edit = (next: Tier[]) => {
    setTiers(next);
    setServerErrors({});
  };

  const submit = async () => {
    setAttempted(true);
    if (Object.keys(checked).length) {
      toast({ variant: 'destructive', title: 'Not submitted', description: 'Fix the tiers marked in red first.' });
      return;
    }
    setBusy(true);
    try {
      const { ok, data } = await postJson(`/api/admin/products/${productId}`, { action: 'tiers', tiers });
      if (!ok) {
        const issues: { path: string; message: string }[] = data?.issues ?? [];
        if (issues.length) setServerErrors(Object.fromEntries(issues.map((i) => [i.path.replace(/^tiers\./, ''), i.message])));
        toast({ variant: 'destructive', title: 'Not submitted', description: data?.error });
        return;
      }
      toast({ title: data.message });
      setAttempted(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Product maximum: <span className="num font-medium text-foreground">{money(maxCents / 100)}</span>. No tier may offer more.
      </p>
      <div className="grid grid-cols-[1fr_1fr_1.5fr_40px] gap-2 text-xs font-medium text-muted-foreground">
        <span>Score from</span>
        <span>Score to</span>
        <span>Maximum amount</span>
        <span />
      </div>
      {tiers.map((tier, i) => (
        <div key={i}>
          <div className="grid grid-cols-[1fr_1fr_1.5fr_40px] gap-2">
            {(['minScore', 'maxScore', 'maxAmount'] as const).map((key) => (
              <Input
                key={key}
                aria-label={key}
                aria-invalid={Boolean(errors[`${i}.${key}`])}
                value={tier[key]}
                disabled={!canSubmit}
                inputMode={key === 'maxAmount' ? 'decimal' : 'numeric'}
                onChange={(e) => edit(tiers.map((t, j) => (j === i ? { ...t, [key]: e.target.value } : t)))}
                className={errors[`${i}.${key}`] ? 'border-destructive' : ''}
              />
            ))}
            <Button type="button" variant="ghost" size="icon" aria-label="Remove tier" disabled={!canSubmit} onClick={() => edit(tiers.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {Object.entries(errors)
            .filter(([k]) => k.startsWith(`${i}.`))
            .map(([k, m]) => (
              <p key={k} className="text-xs text-destructive">
                {m}
              </p>
            ))}
        </div>
      ))}
      {canSubmit && (
        <div className="flex gap-2 pt-1">
          <Button type="button" size="sm" variant="outline" onClick={() => edit([...tiers, { minScore: '', maxScore: '', maxAmount: '' }])}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add tier
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Submit tiers for approval
          </Button>
        </div>
      )}
    </div>
  );
}

interface Quote {
  currency: string;
  principal: number;
  fee: number;
  taxOnFee: number;
  interest: number;
  taxOnInterest: number;
  totalRepayable: number;
  maturityDate: string;
  schedule: { number: number; dueDate: string; principal: number }[];
}

export function LoanCalculator({ endpoint, extra, defaultAmount }: { endpoint: string; extra?: Record<string, unknown>; defaultAmount: string }) {
  const [amount, setAmount] = useState(defaultAmount);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson(endpoint, { ...extra, amount });
      if (!ok) {
        setQuote(null);
        setError(data?.error || 'Could not calculate.');
        return;
      }
      setQuote(data as Quote);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form onSubmit={run} className="flex gap-2">
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
        <Button type="submit" variant="secondary" disabled={busy}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Calculator className="mr-1.5 h-4 w-4" />}
          Calculate
        </Button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {quote && (
        <div className="mt-3 space-y-3 text-sm">
          <dl className="space-y-1">
            {[
              ['Principal', quote.principal],
              ['Service fee', quote.fee],
              ['Tax on fee', quote.taxOnFee],
              ['Interest to maturity', quote.interest],
              ['Tax on interest', quote.taxOnInterest],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="num">{money(value as number)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Total if repaid on {quote.maturityDate}</dt>
              <dd className="num">{money(quote.totalRepayable, quote.currency)}</dd>
            </div>
          </dl>
          {quote.schedule.length > 1 && (
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th>#</th>
                  <th>Due</th>
                  <th className="text-right">Principal</th>
                </tr>
              </thead>
              <tbody>
                {quote.schedule.map((s) => (
                  <tr key={s.number}>
                    <td>{s.number}</td>
                    <td>{s.dueDate}</td>
                    <td className="num text-right">{money(s.principal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted-foreground">Computed by the same engine and terms snapshot a real loan uses. Penalties apply only if payments are late.</p>
        </div>
      )}
    </div>
  );
}
