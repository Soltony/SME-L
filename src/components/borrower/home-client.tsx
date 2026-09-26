'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronRight, Clock, HelpCircle, History, Loader2, PiggyBank, RefreshCw } from 'lucide-react';
import type { LoanView } from '@/lib/lending/loan-view';
import type { ProviderCredit } from '@/lib/lending/provider-credit';
import { alpha, normalizeHex } from '@/lib/brand';
import { money } from '@/components/money';
import { ProviderRail, type RailProvider } from './provider-rail';
import { CreditCard } from './credit-card';
import { LoanCard } from './loan-card';
import { OfferCard } from './offer-card';
import { AccountsSheet, type BorrowerAccount } from './accounts-sheet';

export interface HomeLoan extends LoanView {
  providerId: string;
}

export interface PendingApplication {
  id: string;
  productName: string;
  providerId: string;
  amount: number;
}

/**
 * The borrower's home screen.
 *
 * Everything on it is read through the lender they have selected, because a
 * limit, a product list and an amount owed only mean something next to the name
 * of whoever lent it. A lender's credit and products arrive in one request,
 * kept for as long as the screen is open, so moving back and forth along the
 * rail costs nothing after the first look.
 *
 * The selection is written into the URL with `replaceState` rather than a
 * router navigation: this page is dynamic, so navigating would re-render it on
 * the server for a change no server data depends on.
 */
export function HomeClient({
  providers,
  loans,
  pending,
  accounts: initialAccounts,
  holderName,
  currency,
  isNpl,
  supportPhone,
  initialProviderId,
}: {
  providers: RailProvider[];
  loans: HomeLoan[];
  pending: PendingApplication[];
  accounts: BorrowerAccount[];
  holderName: string;
  currency: string;
  isNpl: boolean;
  supportPhone: string;
  initialProviderId: string | null;
}) {
  const [selectedId, setSelectedId] = useState(initialProviderId ?? providers[0]?.id ?? '');
  const [credit, setCredit] = useState<Record<string, ProviderCredit>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const inFlight = useRef(new Set<string>());

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];
  const color = normalizeHex(selected?.colorHex ?? '');

  const load = useCallback(async (providerId: string) => {
    if (!providerId || inFlight.current.has(providerId)) return;
    inFlight.current.add(providerId);
    setLoadingId(providerId);
    try {
      const response = await fetch(`/api/app/providers/${providerId}/credit`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFailed((f) => ({ ...f, [providerId]: data?.error || 'We could not load this lender just now.' }));
        return;
      }
      setCredit((c) => ({ ...c, [providerId]: data }));
      setFailed((f) => {
        const next = { ...f };
        delete next[providerId];
        return next;
      });
    } catch {
      setFailed((f) => ({ ...f, [providerId]: 'Network error. Please try again.' }));
    } finally {
      inFlight.current.delete(providerId);
      setLoadingId((id) => (id === providerId ? null : id));
    }
  }, []);

  useEffect(() => {
    if (selectedId && !credit[selectedId] && !failed[selectedId]) void load(selectedId);
  }, [selectedId, credit, failed, load]);

  const select = (id: string) => {
    setSelectedId(id);
    const params = new URLSearchParams(window.location.search);
    params.set('lender', id);
    window.history.replaceState(null, '', `?${params.toString()}`);
  };

  const retry = () => {
    if (!selected) return;
    setFailed((f) => {
      const next = { ...f };
      delete next[selected.id];
      return next;
    });
    void load(selected.id);
  };

  const providerLoans = useMemo(() => loans.filter((l) => l.providerId === selected?.id), [loans, selected?.id]);
  const providerPending = useMemo(() => pending.filter((a) => a.providerId === selected?.id), [pending, selected?.id]);
  const owedEverywhere = loans.reduce((sum, l) => sum + l.outstanding.total, 0);

  if (!selected) {
    return (
      <p className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No lender is open for business right now. Please check back later.
      </p>
    );
  }

  const current = credit[selected.id];
  const error = failed[selected.id];
  const loading = !current && !error;

  return (
    <div className="space-y-4">
      {isNpl && (
        <p className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          One of your loans is seriously overdue. Repay it to be able to borrow again.
        </p>
      )}

      <ProviderRail providers={providers} selectedId={selected.id} onSelect={select} />

      <CreditCard
        providerName={selected.name}
        colorHex={selected.colorHex}
        holderName={holderName}
        accountNumber={accounts[0]?.accountNumber ?? null}
        accountCount={accounts.length}
        statusLabel={isNpl ? 'Overdue' : providerLoans.length > 0 ? 'Borrowing' : 'Active'}
        maxLimit={current?.maxLimit ?? 0}
        available={current?.available ?? 0}
        currency={current?.currency ?? currency}
        loading={loading}
        onOpenAccounts={() => setAccountsOpen(true)}
      />

      <div className="flex items-center gap-2">
        <Link
          href="/loans"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ backgroundColor: alpha(color, 0.13), color }}
        >
          <History className="h-4 w-4" />
          Loan history
        </Link>
        {owedEverywhere > 0 && (
          <span className="rounded-xl bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
            You owe <span className="num font-semibold text-foreground">{money(owedEverywhere, currency)}</span> in all
          </span>
        )}
      </div>

      {providerPending.length > 0 && (
        <ul className="space-y-2">
          {providerPending.map((application) => (
            <li key={application.id}>
              <Link
                href={`/applications/${application.id}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Clock className="h-4 w-4 shrink-0 text-warning" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{application.productName}</span>
                    <span className="num block text-xs text-muted-foreground">
                      {money(application.amount, currency)} · under review
                    </span>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {providerLoans.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-bold">Your {selected.name} loans</h2>
          {providerLoans.map((loan) => (
            <LoanCard key={loan.id} loan={loan} colorHex={selected.colorHex} />
          ))}
        </section>
      )}

      <section>
        <h2 className="text-base font-bold">Available loan products</h2>
        <p className="mb-3 text-xs text-muted-foreground">Select a product from {selected.name} to apply.</p>

        {loading && (
          <p className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking what you can borrow…
          </p>
        )}

        {error && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
            <button
              type="button"
              onClick={retry}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        )}

        {current && current.offers.length === 0 && (
          <p className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {selected.name} has no loan products open right now.
          </p>
        )}

        {current && current.offers.length > 0 && (
          <ul className="space-y-3">
            {current.offers.map((offer) => (
              <li key={offer.id}>
                <OfferCard offer={offer} icon={selected.icon} colorHex={selected.colorHex} currency={current.currency} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <PiggyBank className="h-3.5 w-3.5" />
          Repay early, pay less interest
        </span>
        {supportPhone && (
          <a href={`tel:${supportPhone}`} className="flex items-center gap-1.5 underline">
            <HelpCircle className="h-3.5 w-3.5" />
            {supportPhone}
          </a>
        )}
      </footer>

      <AccountsSheet
        open={accountsOpen}
        onOpenChange={setAccountsOpen}
        accounts={accounts}
        shown={accounts[0]?.accountNumber ?? null}
        onRefreshed={setAccounts}
      />
    </div>
  );
}
