import Link from 'next/link';
import { AlertTriangle, BadgeDollarSign, CheckSquare, ClipboardList, Landmark, Scale, Send, TrendingUp, Users } from 'lucide-react';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { hasPermission } from '@/lib/permissions';
import { dateFromDay, dayFromDate, dayToIso, isoToDay, today } from '@/lib/business-date';
import { toCents } from '@/lib/money';
import { portfolioReport } from '@/lib/reports';
import { PageHeader } from '@/components/admin/page-header';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { ActivityChart } from '@/components/admin/activity-chart';
import { moneyCents } from '@/components/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

function percent(part: number, whole: number) {
  if (!whole) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export default async function DashboardPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const scope = user.providerId ? { providerId: user.providerId } : {};
  const settings = await getSettings();
  const currency = String(settings['platform.currency'] || 'ETB');
  const T = today();
  const monthStart = isoToDay(`${dayToIso(T).slice(0, 8)}01`);
  const chartStart = T - 13;

  const [portfolio, submitted, pendingApprovals, unknownDisbursements, queuedDisbursements, disbursedRecent, collectedRecent, ledgerTotals] =
    await Promise.all([
      portfolioReport(user.providerId),
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
        select: { valueDate: true, amount: true },
      }),
      prisma.ledgerLine.aggregate({ where: user.providerId ? { account: { providerId: user.providerId } } : {}, _sum: { debit: true, credit: true } }),
    ]);

  const totals = portfolio.reduce(
    (t, r) => ({
      loans: t.loans + r.activeLoans,
      principal: t.principal + r.principal,
      outstanding: t.outstanding + r.totalOutstanding,
      par30: t.par30 + r.par30,
      par1: t.par1 + r.par1,
      npl: t.npl + r.nplBorrowers,
      available: t.available + (r.cash - r.reserved),
    }),
    { loans: 0, principal: 0, outstanding: 0, par30: 0, par1: 0, npl: 0, available: 0 }
  );

  const series = new Map<number, { disbursed: number; collected: number }>();
  let disbursedToday = 0;
  let disbursedMonth = 0;
  let collectedToday = 0;
  let collectedMonth = 0;
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
    if (day >= monthStart) collectedMonth += cents;
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

  const balanced = toCents(ledgerTotals._sum.debit) === toCents(ledgerTotals._sum.credit);
  const attention = [
    submitted > 0 && hasPermission(user, 'applications', 'read')
      ? { href: '/admin/applications', text: `${submitted} application(s) waiting for review`, icon: ClipboardList }
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
      />

      <StatGrid>
        <StatCard label="Active loans" value={totals.loans.toLocaleString()} icon={BadgeDollarSign} href="/admin/loans?status=ACTIVE" />
        <StatCard label="Principal outstanding" value={moneyCents(totals.principal, currency)} hint={`Total owed ${moneyCents(totals.outstanding, currency)}`} icon={TrendingUp} tone="primary" />
        <StatCard label="PAR 30+" value={percent(totals.par30, totals.principal)} hint={`PAR 1+ ${percent(totals.par1, totals.principal)}`} icon={AlertTriangle} tone={totals.par30 > 0 ? 'warning' : 'default'} href="/admin/reports?tab=aging" />
        <StatCard label="NPL borrowers" value={totals.npl.toLocaleString()} icon={Users} tone={totals.npl > 0 ? 'destructive' : 'default'} href="/admin/borrowers?npl=1" />
        <StatCard label="Disbursed today" value={moneyCents(disbursedToday, currency)} hint={`This month ${moneyCents(disbursedMonth, currency)}`} icon={Send} />
        <StatCard label="Collected today" value={moneyCents(collectedToday, currency)} hint={`This month ${moneyCents(collectedMonth, currency)}`} icon={Landmark} tone="success" />
        <StatCard label="Available to lend" value={moneyCents(totals.available, currency)} hint="Fund cash less reserved disbursements" icon={Scale} />
        <StatCard
          label="Ledger"
          value={balanced ? 'Balanced' : 'OUT OF BALANCE'}
          hint="Total debits vs credits"
          icon={Scale}
          tone={balanced ? 'success' : 'destructive'}
          href={hasPermission(user, 'accounting', 'read') ? '/admin/accounting?tab=verification' : undefined}
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
                  <li key={p.providerId} className="flex justify-between py-2">
                    <span>{p.providerName}</span>
                    <span className="num">{moneyCents(p.principal, currency)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
