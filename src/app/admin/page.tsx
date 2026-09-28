import Link from 'next/link';
import {
  AlertTriangle,
  BadgeDollarSign,
  CheckSquare,
  ClipboardList,
  FileCheck2,
  HandCoins,
  Landmark,
  PiggyBank,
  Receipt,
  Scale,
  Send,
  TrendingUp,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { hasPermission } from '@/lib/permissions';
import { dateFromDay, dayFromDate, dayToIso, isoToDay, today } from '@/lib/business-date';
import { toCents } from '@/lib/money';
import { loanStatusSummary, portfolioReport, productPerformanceReport } from '@/lib/reports';
import { PageHeader } from '@/components/admin/page-header';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { ActivityChart } from '@/components/admin/activity-chart';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { ShareBar } from '@/components/admin/share-bar';
import { StatusBadge } from '@/components/admin/status-badge';
import { moneyCents } from '@/components/money';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

function percent(part: number, whole: number) {
  if (!whole) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Label and amount rows, totalled — for a figure that is the sum of its parts. */
function Breakdown({ rows, total, currency }: { rows: { label: string; value: number }[]; total: { label: string; value: number }; currency: string }) {
  return (
    <dl className="mt-3 space-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cn('num', row.value === 0 && 'text-muted-foreground')}>{moneyCents(row.value)}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
        <dt className="font-medium">{total.label}</dt>
        <dd className="num font-semibold">{moneyCents(total.value, currency)}</dd>
      </div>
    </dl>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ providerId?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  // Bank staff can narrow the dashboard to one provider; provider staff only ever see their own.
  const providers = user.providerId
    ? []
    : await prisma.loanProvider.findMany({ select: { id: true, name: true }, orderBy: { displayOrder: 'asc' } });
  const providerId = user.providerId ?? providers.find((p) => p.id === params.providerId)?.id ?? null;
  const scope = providerId ? { providerId } : {};
  const scopeQuery = !user.providerId && providerId ? `providerId=${providerId}` : '';
  const withScope = (path: string) => (scopeQuery ? `${path}${path.includes('?') ? '&' : '?'}${scopeQuery}` : path);
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');
  const T = today();
  const monthStart = isoToDay(`${dayToIso(T).slice(0, 8)}01`);
  const chartStart = T - 13;

  const [
    portfolio,
    submitted,
    pendingApprovals,
    unknownDisbursements,
    queuedDisbursements,
    disbursedRecent,
    collectedRecent,
    ledgerTotals,
    pendingDocuments,
    lentToDate,
    borrowersServed,
    fundAccounts,
    statuses,
    products,
  ] = await Promise.all([
    portfolioReport(providerId),
    prisma.loanApplication.count({ where: { status: 'SUBMITTED', ...scope } }),
    prisma.pendingChange.count({ where: { status: 'PENDING', NOT: { createdById: user.id }, ...scope } }),
    prisma.disbursementAttempt.count({ where: { status: { in: ['UNKNOWN'] }, loan: scope } }),
    prisma.disbursementAttempt.count({ where: { status: 'PENDING', loan: { status: 'PENDING_DISBURSEMENT', ...scope } } }),
    prisma.loan.findMany({
      where: { disbursementDate: { gte: dateFromDay(Math.min(chartStart, monthStart)) }, ...scope },
      select: { disbursementDate: true, principalAmount: true },
    }),
    prisma.repayment.findMany({
      where: { status: 'POSTED', valueDate: { gte: dateFromDay(Math.min(chartStart, monthStart)) }, loan: scope },
      select: {
        valueDate: true,
        amount: true,
        principalPortion: true,
        interestPortion: true,
        feePortion: true,
        penaltyPortion: true,
        taxPortion: true,
        excessPortion: true,
      },
    }),
    prisma.ledgerLine.aggregate({ where: providerId ? { account: { providerId } } : {}, _sum: { debit: true, credit: true } }),
    // What this user may decide: the bank's documents for bank staff, their own provider's for provider staff.
    prisma.borrowerDocument.count({ where: { status: 'PENDING', providerId: user.providerId ?? null } }),
    prisma.loan.aggregate({ where: { ...scope, disbursementDate: { not: null } }, _sum: { principalAmount: true }, _count: { _all: true } }),
    prisma.borrower.count({ where: { loans: { some: { ...scope, disbursementDate: { not: null } } } } }),
    prisma.ledgerAccount.groupBy({
      by: ['systemKey'],
      where: { systemKey: { in: ['CAPITAL', 'TAX_PAYABLE', 'TAX_RECEIVABLE'] }, ...scope },
      _sum: { balance: true },
    }),
    loanStatusSummary(providerId),
    productPerformanceReport(providerId),
  ]);

  const totals = portfolio.reduce(
    (t, r) => ({
      loans: t.loans + r.activeLoans,
      principal: t.principal + r.principal,
      interest: t.interest + r.interest,
      fee: t.fee + r.fee,
      penalty: t.penalty + r.penalty,
      tax: t.tax + r.tax,
      outstanding: t.outstanding + r.totalOutstanding,
      overduePrincipal: t.overduePrincipal + r.overduePrincipal,
      par30: t.par30 + r.par30,
      par1: t.par1 + r.par1,
      npl: t.npl + r.nplBorrowers,
      available: t.available + (r.cash - r.reserved),
    }),
    { loans: 0, principal: 0, interest: 0, fee: 0, penalty: 0, tax: 0, outstanding: 0, overduePrincipal: 0, par30: 0, par1: 0, npl: 0, available: 0 }
  );
  const fund = (key: string) => toCents(fundAccounts.find((a) => a.systemKey === key)?._sum.balance);
  const capital = fund('CAPITAL');
  const taxPayable = fund('TAX_PAYABLE');
  // Tax is payable once charged; the part still owed by borrowers has not been collected yet.
  const taxCollectedUnremitted = taxPayable - fund('TAX_RECEIVABLE');

  const series = new Map<number, { disbursed: number; collected: number }>();
  let disbursedToday = 0;
  let disbursedMonth = 0;
  let collectedToday = 0;
  const month = { amount: 0, principal: 0, interest: 0, fee: 0, penalty: 0, tax: 0, excess: 0 };
  for (const loan of disbursedRecent) {
    const day = dayFromDate(loan.disbursementDate!);
    const cents = toCents(loan.principalAmount);
    if (day === T) disbursedToday += cents;
    if (day >= monthStart) disbursedMonth += cents;
    if (day >= chartStart) {
      const point = series.get(day) ?? { disbursed: 0, collected: 0 };
      point.disbursed += cents;
      series.set(day, point);
    }
  }
  for (const r of collectedRecent) {
    const day = dayFromDate(r.valueDate);
    const cents = toCents(r.amount);
    if (day === T) collectedToday += cents;
    if (day >= monthStart) {
      month.amount += cents;
      month.principal += toCents(r.principalPortion);
      month.interest += toCents(r.interestPortion);
      month.fee += toCents(r.feePortion);
      month.penalty += toCents(r.penaltyPortion);
      month.tax += toCents(r.taxPortion);
      month.excess += toCents(r.excessPortion);
    }
    if (day >= chartStart) {
      const point = series.get(day) ?? { disbursed: 0, collected: 0 };
      point.collected += cents;
      series.set(day, point);
    }
  }
  const chart = Array.from({ length: 14 }, (_, i) => {
    const day = chartStart + i;
    const point = series.get(day) ?? { disbursed: 0, collected: 0 };
    return { date: dayToIso(day), disbursed: point.disbursed / 100, collected: point.collected / 100 };
  });
  const statusTotal = statuses.reduce((sum, s) => sum + s.loans, 0);

  const balanced = toCents(ledgerTotals._sum.debit) === toCents(ledgerTotals._sum.credit);
  const canSeeAccounting = hasPermission(user, 'accounting', 'read');
  const canSeeReports = hasPermission(user, 'reports', 'read');
  const attention = [
    submitted > 0 && hasPermission(user, 'applications', 'read')
      ? { href: '/admin/applications', text: `${submitted} application(s) waiting for review`, icon: ClipboardList }
      : null,
    pendingDocuments > 0 && hasPermission(user, 'documents', 'read')
      ? { href: '/admin/documents', text: `${pendingDocuments} borrower document(s) waiting for review — borrowers cannot apply until they are approved`, icon: FileCheck2 }
      : null,
    pendingApprovals > 0 && hasPermission(user, 'approvals', 'read')
      ? { href: '/admin/approvals', text: `${pendingApprovals} change(s) waiting for approval`, icon: CheckSquare }
      : null,
    unknownDisbursements > 0 && hasPermission(user, 'disbursements', 'read')
      ? { href: '/admin/disbursements?status=UNKNOWN', text: `${unknownDisbursements} disbursement(s) with an unknown outcome — check core banking`, icon: AlertTriangle }
      : null,
    queuedDisbursements > 0 && hasPermission(user, 'disbursements', 'read')
      ? { href: '/admin/disbursements?status=PENDING', text: `${queuedDisbursements} disbursement(s) queued`, icon: Send }
      : null,
  ].filter((x): x is { href: string; text: string; icon: typeof ClipboardList } => Boolean(x));

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Portfolio as of ${dayToIso(T)}${portfolio[0]?.accruedThrough ? ` · balances accrued through ${portfolio.map((p) => p.accruedThrough).filter(Boolean).sort()[0]}` : ''}`}
        actions={
          canSeeReports ? (
            <Link href={withScope('/admin/reports?tab=overview')} className="text-sm font-medium text-primary hover:underline">
              Analyse a period in Reports
            </Link>
          ) : undefined
        }
      />

      {providers.length > 1 && (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Provider">
          {[{ id: null as string | null, name: 'All providers' }, ...providers].map((p) => (
            <Link
              key={p.id ?? 'all'}
              href={p.id ? `/admin?providerId=${p.id}` : '/admin'}
              aria-current={p.id === providerId ? 'page' : undefined}
              className={cn('rounded-full border px-3 py-1 text-sm font-medium', p.id === providerId ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary')}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}

      <StatGrid>
        <StatCard label="Active loans" value={totals.loans.toLocaleString()} icon={BadgeDollarSign} href={withScope('/admin/loans?status=ACTIVE')} />
        <StatCard label="Principal outstanding" value={moneyCents(totals.principal, currency)} hint={`Total owed ${moneyCents(totals.outstanding, currency)}`} icon={TrendingUp} tone="primary" />
        <StatCard label="PAR 30+" value={percent(totals.par30, totals.principal)} hint={`PAR 1+ ${percent(totals.par1, totals.principal)}`} icon={AlertTriangle} tone={totals.par30 > 0 ? 'warning' : 'default'} href={withScope('/admin/reports?tab=aging')} />
        <StatCard label="NPL borrowers" value={totals.npl.toLocaleString()} icon={Users} tone={totals.npl > 0 ? 'destructive' : 'default'} href="/admin/borrowers?npl=1" />
        <StatCard label="Disbursed today" value={moneyCents(disbursedToday, currency)} hint={`This month ${moneyCents(disbursedMonth, currency)}`} icon={Send} />
        <StatCard label="Collected today" value={moneyCents(collectedToday, currency)} hint={`This month ${moneyCents(month.amount, currency)}`} icon={Landmark} tone="success" />
        <StatCard label="Lent to date" value={moneyCents(toCents(lentToDate._sum.principalAmount), currency)} hint={`${lentToDate._count._all.toLocaleString()} loans paid out`} icon={HandCoins} href={withScope('/admin/loans')} />
        <StatCard label="Borrowers served" value={borrowersServed.toLocaleString()} hint="Received at least one loan" icon={UsersRound} href="/admin/borrowers" />
        <StatCard label="Capital" value={moneyCents(capital, currency)} hint="Put into the lending funds, net of withdrawals" icon={PiggyBank} href={canSeeAccounting ? withScope('/admin/accounting') : undefined} />
        <StatCard label="Available to lend" value={moneyCents(totals.available, currency)} hint="Fund cash less reserved disbursements" icon={Wallet} href={canSeeReports ? withScope('/admin/reports?tab=funds') : undefined} />
        <StatCard
          label="Tax payable"
          value={moneyCents(taxPayable, currency)}
          hint={`${moneyCents(taxCollectedUnremitted, currency)} collected, not yet remitted`}
          icon={Receipt}
          href={canSeeAccounting ? withScope('/admin/accounting') : undefined}
        />
        <StatCard
          label="Ledger"
          value={balanced ? 'Balanced' : 'OUT OF BALANCE'}
          hint="Total debits vs credits"
          icon={Scale}
          tone={balanced ? 'success' : 'destructive'}
          href={canSeeAccounting ? withScope('/admin/accounting?tab=verification') : undefined}
        />
      </StatGrid>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold">Disbursed vs collected — last 14 days</h2>
          <div className="mt-3">
            <ActivityChart data={chart} currency={currency} />
          </div>
        </section>
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Needs attention</h2>
          {attention.length === 0 ? (
            <p className="mt-6 text-center text-sm text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {attention.map(({ href, text, icon: Icon }) => (
                <li key={href}>
                  <Link href={href} className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm transition hover:border-primary/60 hover:bg-secondary/40">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    {text}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {portfolio.length > 1 && (
            <>
              <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By provider</h3>
              <ul className="mt-2 divide-y divide-border text-sm">
                {portfolio.map((p) => (
                  <li key={p.providerId}>
                    <Link href={`/admin?providerId=${p.providerId}`} className="flex justify-between py-2 hover:text-primary">
                      <span>{p.providerName}</span>
                      <span className="num">{moneyCents(p.principal, currency)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Owed by borrowers</h2>
          <p className="text-xs text-muted-foreground">
            Active loans, as of their last accrual · {moneyCents(totals.overduePrincipal)} principal overdue
          </p>
          <Breakdown
            currency={currency}
            rows={[
              { label: 'Principal', value: totals.principal },
              { label: 'Interest', value: totals.interest },
              { label: 'Service fees', value: totals.fee },
              { label: 'Penalties', value: totals.penalty },
              { label: 'Tax', value: totals.tax },
            ]}
            total={{ label: 'Total receivable', value: totals.outstanding }}
          />
        </section>
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Collected this month</h2>
          <p className="text-xs text-muted-foreground">Posted receipts since {dayToIso(monthStart)}, as they were allocated</p>
          <Breakdown
            currency={currency}
            rows={[
              { label: 'Principal', value: month.principal },
              { label: 'Interest', value: month.interest },
              { label: 'Service fees', value: month.fee },
              { label: 'Penalties', value: month.penalty },
              { label: 'Tax', value: month.tax },
              { label: 'Overpayments held', value: month.excess },
            ]}
            total={{ label: 'Total collected', value: month.amount }}
          />
        </section>
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Loans by status</h2>
          <p className="text-xs text-muted-foreground">Every loan on the books, {statusTotal.toLocaleString()} in all</p>
          <ul className="mt-3 space-y-2.5 text-sm">
            {statuses.map((s) => (
              <li key={s.key}>
                <div className="flex items-center justify-between gap-3">
                  <span className={cn(s.key === 'PAST_DUE' && s.loans > 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}>{s.label}</span>
                  <span className="num">
                    {s.loans.toLocaleString()}
                    <span className="ml-2 inline-block w-12 text-right text-xs text-muted-foreground">{percent(s.loans, statusTotal)}</span>
                  </span>
                </div>
                <ShareBar share={statusTotal ? s.loans / statusTotal : 0} className="mt-1 h-1.5" />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold">Products</h2>
      <TableCard>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Product</th>
              <th className="px-4 py-2.5 text-right font-semibold">Active loans</th>
              <th className="px-4 py-2.5 text-right font-semibold">Principal outstanding</th>
              <th className="px-4 py-2.5 text-right font-semibold">Past due</th>
              <th className="px-4 py-2.5 text-right font-semibold">PAR 30+</th>
              <th className="px-4 py-2.5 text-right font-semibold">Loans to date</th>
              <th className="px-4 py-2.5 text-right font-semibold">Paid off</th>
              <th className="px-4 py-2.5 text-right font-semibold">Written off</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {products.length === 0 && <EmptyRow colSpan={8} message="No products yet." />}
            {products.map((p) => (
              <tr key={p.productId} className="hover:bg-secondary/30">
                <td className="px-4 py-2.5">
                  <Link href={`/admin/products/${p.productId}`} className="font-medium text-primary hover:underline">
                    {p.productName}
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {!providerId && <span>{p.providerName}</span>}
                    {p.status !== 'ACTIVE' && <StatusBadge status={p.status} />}
                  </div>
                </td>
                <td className="num px-4 py-2.5 text-right">{p.activeLoans.toLocaleString()}</td>
                <td className="num px-4 py-2.5 text-right">{moneyCents(p.principalOutstanding)}</td>
                <td className={cn('num px-4 py-2.5 text-right', p.pastDueLoans > 0 && 'font-semibold text-destructive')}>
                  {p.pastDueLoans.toLocaleString()}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">({percent(p.pastDueLoans, p.activeLoans)})</span>
                </td>
                <td className="num px-4 py-2.5 text-right">{percent(p.par30, p.principalOutstanding)}</td>
                <td className="num px-4 py-2.5 text-right">
                  {p.disbursedLoans.toLocaleString()}
                  <span className="block text-xs text-muted-foreground">{moneyCents(p.disbursedAmount, currency)}</span>
                </td>
                <td className="num px-4 py-2.5 text-right">{p.paidOffLoans.toLocaleString()}</td>
                <td className={cn('num px-4 py-2.5 text-right', p.writtenOffLoans > 0 && 'text-destructive')}>
                  {p.writtenOffLoans.toLocaleString()}
                  <span className="ml-1 text-xs text-muted-foreground">({percent(p.writtenOffLoans, p.disbursedLoans)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
