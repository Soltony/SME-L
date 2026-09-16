import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { CheckCircle2, XCircle } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { dateFromDay, dayFromDate, dayToIso, formatDay, parseIsoDay, today } from '@/lib/business-date';
import { toCents } from '@/lib/money';
import { JOURNAL_TYPES } from '@/lib/types';
import { trialBalance, verifyLedger } from '@/lib/accounting/ledger';
import { ACCOUNT_TYPE_LABELS } from '@/lib/accounting/chart';
import { fundPosition } from '@/lib/lending/loan-service';
import { PageHeader } from '@/components/admin/page-header';
import { FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { ActionDialog, ConfirmButton } from '@/components/admin/action-dialog';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { Button } from '@/components/ui/button';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';
import type { AccountType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounting' };

const TABS = [
  { key: 'accounts', label: 'Chart of accounts' },
  { key: 'journals', label: 'Journals' },
  { key: 'trial-balance', label: 'Trial balance' },
  { key: 'verification', label: 'Verification' },
];

type Search = { providerId?: string; tab?: string; asOf?: string; type?: string; from?: string; to?: string; page?: string };

export default async function AccountingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const tab = TABS.some((t) => t.key === params.tab) ? params.tab! : 'accounts';
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const providers = await prisma.loanProvider.findMany({
    where: user.providerId ? { id: user.providerId } : {},
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  });
  const provider = providers.find((p) => p.id === (user.providerId ?? params.providerId)) ?? providers[0];
  if (!provider) {
    return (
      <>
        <PageHeader title="Accounting" />
        <div className="panel p-6 text-sm text-muted-foreground">Create a provider first.</div>
      </>
    );
  }

  const funds = await fundPosition(prisma, provider.id);
  const payable = await prisma.ledgerAccount.findUnique({
    where: { providerId_systemKey: { providerId: provider.id, systemKey: 'TAX_PAYABLE' } },
    select: { balance: true },
  });
  const canRequest = hasPermission(user, 'accounting', 'create');
  const tabHref = (key: string) => `/admin/accounting?providerId=${provider.id}&tab=${key}`;

  return (
    <>
      <PageHeader
        title="Accounting"
        description={`Double-entry books for ${provider.name}. Journals are immutable; corrections are reversing entries.`}
        actions={
          <>
            {canRequest && (
              <>
                <ActionDialog
                  label="Capital"
                  title="Capital movement"
                  description="Money the provider puts into, or takes out of, its lending fund. A withdrawal cannot exceed funds not already lent or reserved. Needs approval."
                  endpoint="/api/admin/accounting"
                  extra={{ action: 'capital', providerId: provider.id }}
                  submitLabel="Send for approval"
                  fields={[
                    { name: 'direction', label: 'Direction', type: 'select', required: true, defaultValue: 'INJECT', options: [{ value: 'INJECT', label: 'Inject capital' }, { value: 'WITHDRAW', label: 'Withdraw capital' }] },
                    { name: 'amount', label: `Amount (${currency})`, type: 'amount', required: true },
                    { name: 'reference', label: 'Bank reference', required: true, help: 'Unique; the same reference cannot post twice.' },
                    { name: 'note', label: 'Note' },
                  ]}
                />
                <ActionDialog
                  label="Remit tax"
                  title="Remit tax to the authority"
                  description={`Tax payable is ${moneyCents(toCents(payable?.balance), currency)}. Needs approval.`}
                  endpoint="/api/admin/accounting"
                  extra={{ action: 'tax-remittance', providerId: provider.id }}
                  submitLabel="Send for approval"
                  fields={[
                    { name: 'amount', label: `Amount (${currency})`, type: 'amount', required: true },
                    { name: 'reference', label: 'Payment reference', required: true },
                  ]}
                />
              </>
            )}
            {hasPermission(user, 'accounting', 'update') && !user.providerId && (
              <ConfirmButton label="Run accruals now" confirm="Accrue every active loan up to today? Safe to repeat." endpoint="/api/admin/accounting" body={{ action: 'run-accruals' }} />
            )}
          </>
        }
      />

      {!user.providerId && providers.length > 1 && (
        <FilterBar>
          <input type="hidden" name="tab" value={tab} />
          <SelectFilter name="providerId" label="Provider" value={provider.id} allLabel="Choose…" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          <FilterSubmit />
        </FilterBar>
      )}

      <StatGrid>
        <StatCard label="Fund cash" value={moneyCents(funds.cash, currency)} />
        <StatCard label="Reserved for disbursement" value={moneyCents(funds.reserved, currency)} />
        <StatCard label="Available to lend" value={moneyCents(funds.available, currency)} tone="primary" />
        <StatCard label="Tax payable" value={moneyCents(toCents(payable?.balance), currency)} />
      </StatGrid>

      <nav className="my-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={tabHref(t.key)} className={cn('rounded-full border px-3 py-1 text-sm font-medium', t.key === tab ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary')}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'accounts' && <AccountsTab providerId={provider.id} currency={currency} />}
      {tab === 'journals' && <JournalsTab providerId={provider.id} params={params} currency={currency} />}
      {tab === 'trial-balance' && <TrialBalanceTab providerId={provider.id} asOf={parseIsoDay(params.asOf, today())} currency={currency} />}
      {tab === 'verification' && <VerificationTab providerId={provider.id} currency={currency} />}
    </>
  );
}

async function AccountsTab({ providerId, currency }: { providerId: string; currency: string }) {
  const accounts = await prisma.ledgerAccount.findMany({ where: { providerId }, orderBy: { code: 'asc' } });
  const types = Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[];
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {types.map((type) => {
        const rows = accounts.filter((a) => a.type === type);
        if (!rows.length) return null;
        const total = rows.reduce((s, a) => s + toCents(a.balance), 0);
        return (
          <section key={type} className="panel p-4 text-sm">
            <h2 className="mb-2 flex justify-between font-semibold">
              {ACCOUNT_TYPE_LABELS[type]}
              <span className="num">{moneyCents(total, currency)}</span>
            </h2>
            <ul className="divide-y divide-border">
              {rows.map((a) => (
                <li key={a.id} className="flex justify-between gap-2 py-1.5">
                  <Link href={`/admin/accounting/accounts/${a.id}`} className="text-primary hover:underline">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{a.code}</span>
                    {a.name}
                  </Link>
                  <span className="num">{moneyCents(toCents(a.balance))}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

async function JournalsTab({ providerId, params, currency }: { providerId: string; params: Search; currency: string }) {
  const to = parseIsoDay(params.to, today());
  const from = parseIsoDay(params.from, to - 30);
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 30;
  const where: Prisma.JournalEntryWhereInput = {
    providerId,
    businessDate: { gte: dateFromDay(from), lte: dateFromDay(to) },
    ...((JOURNAL_TYPES as readonly string[]).includes(params.type ?? '') ? { type: params.type } : {}),
  };
  const [journals, total] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      include: { lines: { include: { account: { select: { code: true, name: true } } } }, loan: { select: { id: true, loanNumber: true } } },
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.journalEntry.count({ where }),
  ]);

  return (
    <>
      <FilterBar>
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="tab" value="journals" />
        <TextFilter name="from" label="From" type="date" value={dayToIso(from)} />
        <TextFilter name="to" label="To" type="date" value={dayToIso(to)} />
        <SelectFilter name="type" label="Type" value={params.type} options={JOURNAL_TYPES.map((t) => ({ value: t, label: t }))} />
        <FilterSubmit />
      </FilterBar>
      <div className="space-y-2">
        {journals.length === 0 && <div className="panel p-6 text-center text-sm text-muted-foreground">No journals in this range.</div>}
        {journals.map((j) => (
          <details key={j.id} className="panel p-3 text-sm">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{j.journalNo}</span>{' '}
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-semibold">{j.type}</span> {j.description}
                {j.loan && (
                  <Link href={`/admin/loans/${j.loan.id}`} className="ml-1 font-mono text-xs text-primary hover:underline">
                    {j.loan.loanNumber}
                  </Link>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDay(dayFromDate(j.businessDate))} · <span className="num">{moneyCents(toCents(j.totalAmount), currency)}</span>
              </span>
            </summary>
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Account</th>
                  <th className="py-1">Memo</th>
                  <th className="py-1 text-right">Debit</th>
                  <th className="py-1 text-right">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {j.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-1">
                      <span className="mr-1 font-mono text-muted-foreground">{line.account.code}</span>
                      {line.account.name}
                    </td>
                    <td className="py-1 text-muted-foreground">{line.memo}</td>
                    <td className="num py-1 text-right">{toCents(line.debit) ? moneyCents(toCents(line.debit)) : ''}</td>
                    <td className="num py-1 text-right">{toCents(line.credit) ? moneyCents(toCents(line.credit)) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </div>
      <div className="panel mt-3">
        <Pager page={page} pageSize={pageSize} total={total} basePath="/admin/accounting" params={{ providerId, tab: 'journals', from: dayToIso(from), to: dayToIso(to), type: params.type }} />
      </div>
    </>
  );
}

async function TrialBalanceTab({ providerId, asOf, currency }: { providerId: string; asOf: number; currency: string }) {
  const rows = await trialBalance(providerId, asOf);
  const totals = rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
  return (
    <>
      <FilterBar>
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="tab" value="trial-balance" />
        <TextFilter name="asOf" label="As of" type="date" value={dayToIso(asOf)} />
        <FilterSubmit />
        <Button asChild variant="outline" size="sm" className="h-9">
          <a href={`/api/admin/accounting/export?kind=trial-balance&providerId=${providerId}&asOf=${dayToIso(asOf)}`}>Export CSV</a>
        </Button>
      </FilterBar>
      <TableCard>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Code</th>
              <th className="px-4 py-2.5 font-semibold">Account</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 text-right font-semibold">Debit</th>
              <th className="px-4 py-2.5 text-right font-semibold">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td className="px-4 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-2">
                  <Link href={`/admin/accounting/accounts/${r.accountId}?to=${dayToIso(asOf)}`} className="text-primary hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{r.type}</td>
                <td className="num px-4 py-2 text-right">{r.debit ? moneyCents(r.debit) : ''}</td>
                <td className="num px-4 py-2 text-right">{r.credit ? moneyCents(r.credit) : ''}</td>
              </tr>
            ))}
            <tr className="bg-secondary/40 font-semibold">
              <td className="px-4 py-2" colSpan={3}>
                Total {totals.debit === totals.credit ? <span className="ml-2 text-success">balanced</span> : <span className="ml-2 text-destructive">OUT OF BALANCE</span>}
              </td>
              <td className="num px-4 py-2 text-right">{moneyCents(totals.debit, currency)}</td>
              <td className="num px-4 py-2 text-right">{moneyCents(totals.credit, currency)}</td>
            </tr>
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

async function VerificationTab({ providerId, currency }: { providerId: string; currency: string }) {
  const checks = await verifyLedger(providerId);
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <section className="panel p-4 text-sm">
      <p className={cn('mb-3 font-semibold', failed ? 'text-destructive' : 'text-success')}>
        {failed ? `${failed} of ${checks.length} checks failed.` : `All ${checks.length} checks passed.`}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        Recomputed live from every ledger line and every loan: debits against credits, each account&apos;s cached balance against its own lines, and
        each control account against the loan balances it summarises. A failure here is a defect, never a rounding difference.
      </p>
      <ul className="divide-y divide-border">
        {checks.map((c, i) => (
          <li key={i} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2">
              {c.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-destructive" />}
              {c.check}
            </span>
            <span className="num text-xs text-muted-foreground">
              {moneyCents(c.expected, currency)}
              {!c.ok && ` ≠ ${moneyCents(c.actual)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
