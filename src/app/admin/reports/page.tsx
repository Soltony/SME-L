import Link from 'next/link';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { dayToIso, parseIsoDay, today } from '@/lib/business-date';
import { isNbeClass, NBE_CLASSES, reportPeriods } from '@/lib/report-helpers';
import { PageHeader } from '@/components/admin/page-header';
import { FilterBar } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OverviewTab } from './overview-tab';
import { PortfolioTab } from './portfolio-tab';
import { AgingTab } from './aging-tab';
import { CollectionsTab } from './collections-tab';
import { IncomeTab } from './income-tab';
import { DisbursementsTab } from './disbursements-tab';
import { FundUtilizationTab } from './fund-utilization-tab';
import { RegulatoryTab } from './regulatory-tab';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports' };

/** The longest range any report accepts, as the CSV export enforces. */
const MAX_RANGE_DAYS = 3660;

const TABS: {
  key: string;
  label: string;
  ranged: boolean;
  searchable?: boolean;
  exports: { report: string; label: string }[];
}[] = [
  { key: 'overview', label: 'Overview', ranged: true, exports: [] },
  { key: 'portfolio', label: 'Portfolio', ranged: false, exports: [{ report: 'portfolio', label: 'Export CSV' }] },
  {
    key: 'aging',
    label: 'Aging & classification',
    ranged: false,
    searchable: true,
    exports: [
      { report: 'classification', label: 'Export classification' },
      { report: 'aging', label: 'Export DPD buckets' },
      { report: 'borrower-aging', label: 'Export borrowers' },
    ],
  },
  {
    key: 'collections',
    label: 'Collections',
    ranged: true,
    exports: [
      { report: 'collections', label: 'Export daily totals' },
      { report: 'receipts', label: 'Export receipts' },
    ],
  },
  { key: 'income', label: 'Income', ranged: true, exports: [{ report: 'income', label: 'Export CSV' }] },
  { key: 'disbursements', label: 'Disbursements', ranged: true, exports: [{ report: 'disbursements', label: 'Export CSV' }] },
  { key: 'funds', label: 'Fund utilization', ranged: true, exports: [{ report: 'fund-utilization', label: 'Export CSV' }] },
  { key: 'regulatory', label: 'NBE loan register', ranged: true, searchable: true, exports: [{ report: 'regulatory', label: 'Export register' }] },
];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; providerId?: string; from?: string; to?: string; q?: string; class?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const tab = TABS.find((t) => t.key === params.tab) ?? TABS[0];
  const providerId = user.providerId ?? (params.providerId || null);
  const T = today();
  let to = parseIsoDay(params.to, T);
  let from = parseIsoDay(params.from, to - 30);
  if (from > to) [from, to] = [to, from];
  if (to - from > MAX_RANGE_DAYS) from = to - MAX_RANGE_DAYS;
  const q = tab.searchable ? params.q?.trim() || undefined : undefined;
  const classification = tab.key === 'aging' && isNbeClass(params.class) ? params.class : null;
  const page = Math.max(1, Number(params.page) || 1);
  const currency = String((await getSettings())['platform.currency'] || 'ETB');
  const providers = user.providerId ? [] : await prisma.loanProvider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });

  const scope = !user.providerId && providerId ? { providerId } : {};
  const range = { from: dayToIso(from), to: dayToIso(to) };
  const explicitRange = params.from || params.to ? range : {};
  const href = (values: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value) search.set(key, value);
    return `/admin/reports?${search.toString()}`;
  };
  // What a pager or export link needs to reproduce the view being looked at.
  const viewParams = {
    tab: tab.key,
    ...scope,
    ...(tab.ranged ? range : {}),
    q,
    class: classification ?? undefined,
  };
  const exportQuery = new URLSearchParams({
    ...(providerId ? { providerId } : {}),
    ...range,
    ...(q ? { q } : {}),
    ...(classification ? { class: classification } : {}),
  });

  return (
    <>
      <PageHeader
        title="Reports"
        description="Computed from the ledger and the loan book. Income is shown both as earned (accrual) and as collected (cash)."
        actions={
          tab.exports.length > 0
            ? tab.exports.map((e) => (
                <Button key={e.report} asChild variant="outline" size="sm">
                  <a href={`/api/admin/reports/export?report=${e.report}&${exportQuery.toString()}`}>{e.label}</a>
                </Button>
              ))
            : undefined
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href({ tab: t.key, ...scope, ...(t.ranged ? explicitRange : {}) })}
            className={cn('rounded-full border px-3 py-1 text-sm font-medium', t.key === tab.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <FilterBar>
        <input type="hidden" name="tab" value={tab.key} />
        {!user.providerId && (
          <SelectFilter name="providerId" label="Provider" value={providerId ?? undefined} allLabel="All providers" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        {tab.ranged && (
          <>
            <TextFilter name="from" label="From" type="date" value={range.from} />
            <TextFilter name="to" label="To" type="date" value={range.to} />
          </>
        )}
        {tab.searchable && <TextFilter name="q" label="Search" value={q} placeholder="Name, phone, loan no. or account" />}
        {tab.key === 'aging' && (
          <SelectFilter
            name="class"
            label="Borrower class"
            value={classification ?? undefined}
            allLabel="Any past due"
            options={NBE_CLASSES.map((c) => ({ value: c.key, label: `${c.label} (${c.range})` }))}
          />
        )}
        <FilterSubmit />
      </FilterBar>
      {tab.ranged && (
        <div className="-mt-2 mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="mr-1 text-muted-foreground">Period:</span>
          {reportPeriods(T).map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.key}
                href={href({ tab: tab.key, ...scope, from: dayToIso(p.from), to: dayToIso(p.to), q })}
                aria-current={active ? 'true' : undefined}
                className={cn('rounded-md border px-2 py-1 font-medium', active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground')}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
      )}

      {tab.key === 'overview' && <OverviewTab providerId={providerId} from={from} to={to} currency={currency} />}
      {tab.key === 'portfolio' && <PortfolioTab providerId={providerId} currency={currency} />}
      {tab.key === 'aging' && (
        <AgingTab providerId={providerId} currency={currency} classification={classification} q={q} page={page} pagerParams={viewParams} />
      )}
      {tab.key === 'collections' && <CollectionsTab providerId={providerId} from={from} to={to} currency={currency} />}
      {tab.key === 'income' && <IncomeTab providerId={providerId} from={from} to={to} currency={currency} />}
      {tab.key === 'disbursements' && <DisbursementsTab providerId={providerId} from={from} to={to} />}
      {tab.key === 'funds' && <FundUtilizationTab providerId={providerId} from={from} to={to} currency={currency} />}
      {tab.key === 'regulatory' && <RegulatoryTab providerId={providerId} from={from} to={to} currency={currency} q={q} page={page} pagerParams={viewParams} />}
    </>
  );
}
