'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Clock, Landmark, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { money } from '@/components/money';

interface Eligibility {
  eligible: boolean;
  reason: string;
  minAmount: number;
  maxAmount: number;
  terms: { id: string; version: number; content: string; alreadyAccepted: boolean } | null;
  accounts: { accountNumber: string; accountName: string | null }[];
}

interface Quote {
  fee: number;
  taxOnFee: number;
  interest: number;
  taxOnInterest: number;
  totalRepayable: number;
  maturityDate: string;
  schedule: { number: number; dueDate: string; principal: number }[];
}

type Result = { applicationId: string; status: string; loanId: string | null; disbursement: string | null };

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

export function ApplyFlow({
  productId,
  currency,
  requiresReview,
  documents,
}: {
  productId: string;
  currency: string;
  requiresReview: boolean;
  documents: { key: string; name: string }[];
}) {
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const { ok, data } = await call(`/api/app/products/${productId}/eligibility`);
    if (!ok) {
      setLoadError(data?.error || 'Could not check your eligibility.');
      return;
    }
    setEligibility(data);
    setAccepted(Boolean(data.terms?.alreadyAccepted));
    if (data.eligible) setAmount((a) => a || String(Math.floor(data.maxAmount)));
    if (data.accounts?.length) setAccount((acc) => acc || data.accounts[0].accountNumber);
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!eligibility?.eligible || !amount) return;
    const timer = setTimeout(async () => {
      const { ok, data } = await call(`/api/app/products/${productId}/quote`, { method: 'POST', body: JSON.stringify({ amount }) });
      if (ok) {
        setQuote(data);
        setQuoteError(null);
      } else {
        setQuote(null);
        setQuoteError(data?.error || null);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [amount, eligibility, productId]);

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const { ok, data } = await call('/api/app/accounts', { method: 'POST' });
      if (!ok) {
        setLoadError(data?.error || 'Could not load your accounts.');
        return;
      }
      await load();
      if (data.accounts?.[0]) setAccount(data.accounts[0].accountNumber);
    } finally {
      setLoadingAccounts(false);
    }
  };

  const submit = async () => {
    if (!eligibility) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { ok, data } = await call('/api/app/applications', {
        method: 'POST',
        body: JSON.stringify({ productId, amount, accountNumber: account, acceptedTermsId: eligibility.terms?.id ?? null }),
      });
      if (!ok) {
        setSubmitError(data?.error || 'The application was not accepted.');
        return;
      }
      setResult(data);
    } catch {
      setSubmitError('Network error. Your application may not have been sent — check My loans before trying again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const disbursed = result.status === 'DISBURSED';
    const review = result.status === 'SUBMITTED';
    return (
      <section className="rounded-2xl border border-border bg-card p-5 text-center">
        {disbursed ? <CheckCircle2 className="mx-auto h-10 w-10 text-success" /> : review ? <Clock className="mx-auto h-10 w-10 text-warning" /> : <AlertCircle className="mx-auto h-10 w-10 text-warning" />}
        <h2 className="mt-2 text-lg font-bold">
          {disbursed ? 'Money sent!' : review ? 'Application received' : result.status === 'FAILED' ? 'The bank could not send the money' : 'Approved'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {disbursed
            ? `${money(Number(amount), currency)} has been sent to your account.`
            : review
              ? documents.length
                ? 'Upload the requested documents so a loan officer can review your application.'
                : 'A loan officer will review your application shortly.'
              : result.status === 'FAILED'
                ? 'Nothing is owed. Please try again later.'
                : 'Your loan is being sent to your account. We will confirm by SMS.'}
        </p>
        <Button asChild className="mt-4 w-full">
          <Link href={result.loanId && result.status !== 'FAILED' ? `/loans/${result.loanId}` : `/applications/${result.applicationId}`}>
            {review && documents.length ? 'Upload documents' : 'View details'}
          </Link>
        </Button>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {loadError}
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
        </Button>
      </section>
    );
  }

  if (!eligibility) {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking what you can borrow…
      </p>
    );
  }

  if (!eligibility.eligible) {
    return (
      <section className="flex gap-2 rounded-2xl border border-border bg-card p-4 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        {eligibility.reason}
      </section>
    );
  }

  const numeric = Number(amount);
  const valid = Number.isFinite(numeric) && numeric >= eligibility.minAmount && numeric <= eligibility.maxAmount && /^\d+(\.\d{1,2})?$/.test(amount);

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <div>
        <p className="text-sm font-semibold">How much do you need?</p>
        <p className="text-xs text-muted-foreground">
          You can borrow {money(eligibility.minAmount)} to {money(eligibility.maxAmount, currency)}.
        </p>
        <Input className="num mt-2 h-12 text-lg font-semibold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Amount" />
        <input
          type="range"
          className="mt-3 w-full accent-[hsl(var(--primary))]"
          min={eligibility.minAmount}
          max={eligibility.maxAmount}
          step={100}
          value={valid ? numeric : eligibility.minAmount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Amount slider"
        />
        {!valid && amount && <p className="text-xs text-destructive">Enter an amount within your limit.</p>}
        {quoteError && <p className="text-xs text-destructive">{quoteError}</p>}
      </div>

      {quote && valid && (
        <div className="rounded-xl bg-secondary/60 p-3 text-sm">
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Service fee (incl. tax)</dt>
              <dd className="num">{money(quote.fee + quote.taxOnFee)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Interest to {quote.maturityDate} (incl. tax)</dt>
              <dd className="num">{money(quote.interest + quote.taxOnInterest)}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Total to repay</dt>
              <dd className="num">{money(quote.totalRepayable, currency)}</dd>
            </div>
          </dl>
          {quote.schedule.length > 1 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {quote.schedule.map((s) => (
                <li key={s.number} className="flex justify-between">
                  <span>
                    Installment {s.number} · {s.dueDate}
                  </span>
                  <span className="num">{money(s.principal)} + charges</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">Repay early and you pay less interest — it is charged only for the days you have the money.</p>
        </div>
      )}

      <div>
        <p className="text-sm font-semibold">Send it to</p>
        {eligibility.accounts.length === 0 ? (
          <Button type="button" variant="outline" className="mt-2 w-full" onClick={loadAccounts} disabled={loadingAccounts}>
            {loadingAccounts ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Landmark className="mr-2 h-4 w-4" />}
            Load my bank accounts
          </Button>
        ) : (
          <div className="mt-2 space-y-2">
            {eligibility.accounts.map((a) => (
              <label key={a.accountNumber} className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="account" checked={account === a.accountNumber} onChange={() => setAccount(a.accountNumber)} />
                <span>
                  <span className="num block font-mono">{a.accountNumber}</span>
                  <span className="block text-xs text-muted-foreground">{a.accountName}</span>
                </span>
              </label>
            ))}
            <button type="button" onClick={loadAccounts} className="text-xs text-muted-foreground underline" disabled={loadingAccounts}>
              Refresh accounts from the bank
            </button>
          </div>
        )}
      </div>

      {eligibility.terms && (
        <div className="rounded-xl border border-border p-3 text-sm">
          <details>
            <summary className="cursor-pointer font-medium">Terms &amp; conditions (version {eligibility.terms.version})</summary>
            <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{eligibility.terms.content}</p>
          </details>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />I have read and accept the terms and conditions.
          </label>
        </div>
      )}

      {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      <Button
        className="gold h-12 w-full text-base font-bold"
        disabled={submitting || !valid || !account || (Boolean(eligibility.terms) && !accepted)}
        onClick={submit}
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {requiresReview ? 'Submit application' : `Get ${valid ? money(numeric, currency) : 'loan'}`}
      </Button>
    </section>
  );
}
