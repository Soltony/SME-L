import { AlertTriangle, BadgeDollarSign, Landmark, Percent, Scale, Send, TrendingUp, Wallet } from 'lucide-react';
import { dayToIso, type Day } from '@/lib/business-date';
import { NBE_CLASSES, type TrendGranularity } from '@/lib/report-helpers';
import { classificationReport, nplPrincipal, overviewReport, portfolioReport, sumClassification } from '@/lib/reports';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { moneyCents } from '@/components/money';
import { percentOf, SectionTitle } from './report-table';
import { TrendChart } from './trend-chart';

function periodLabel(period: string, granularity: TrendGranularity) {
  const date = new Date(`${granularity === 'day' ? period : `${period}-01`}T00:00:00Z`);
  return date.toLocaleDateString(
    'en-GB',
    granularity === 'day' ? { day: '2-digit', month: 'short', timeZone: 'UTC' } : { month: 'short', year: 'numeric', timeZone: 'UTC' }
  );
}

export async function OverviewTab({ providerId, from, to, currency }: { providerId: string | null; from: Day; to: Day; currency: string }) {
  const [overview, portfolio, classes] = await Promise.all([overviewReport(from, to, providerId), portfolioReport(providerId), classificationReport(providerId)]);
  const book = portfolio.reduce(
    (t, r) => ({
      loans: t.loans + r.activeLoans,
      principal: t.principal + r.principal,
      outstanding: t.outstanding + r.totalOutstanding,
      par1: t.par1 + r.par1,
      par30: t.par30 + r.par30,
      available: t.available + (r.cash - r.reserved),
    }),
    { loans: 0, principal: 0, outstanding: 0, par1: 0, par30: 0, available: 0 }
  );
  const classification = sumClassification(classes);
  const npl = nplPrincipal(classification);
  const { disbursed, collected } = overview;
  const income = collected.interest + collected.fee + collected.penalty;
  const scope = providerId ? `&providerId=${providerId}` : '';
  const trend = overview.trend.map((p) => ({ label: periodLabel(p.period, overview.granularity), disbursed: p.disbursed / 100, collected: p.collected / 100 }));

  return (
    <>
      <SectionTitle title={`In the period · ${dayToIso(from)} to ${dayToIso(to)}`} />
      <StatGrid>
        <StatCard label="Disbursed" value={moneyCents(disbursed.amount, currency)} hint={`${disbursed.loans.toLocaleString()} loans to ${disbursed.borrowers.toLocaleString()} borrowers`} icon={Send} />
        <StatCard label="Collected" value={moneyCents(collected.amount, currency)} hint={`${collected.receipts.toLocaleString()} receipts`} icon={Landmark} tone="success" />
        <StatCard label="Average loan" value={moneyCents(disbursed.loans ? Math.round(disbursed.amount / disbursed.loans) : 0, currency)} hint="Disbursed ÷ loans" icon={BadgeDollarSign} />
        {/* Not a collection rate: receipts include repayments of loans made before the period, so this can pass 100%. */}
        <StatCard label="Collected vs disbursed" value={percentOf(collected.amount, disbursed.amount)} hint="Over 100% means earlier loans are repaying" icon={Percent} />
      </StatGrid>

      <SectionTitle title="The book today" />
      <StatGrid>
        <StatCard label="Principal outstanding" value={moneyCents(book.principal, currency)} hint={`${book.loans.toLocaleString()} active loans · total owed ${moneyCents(book.outstanding, currency)}`} icon={TrendingUp} tone="primary" />
        <StatCard label="PAR 30+" value={percentOf(book.par30, book.principal)} hint={`PAR 1+ ${percentOf(book.par1, book.principal)}`} icon={AlertTriangle} tone={book.par30 > 0 ? 'warning' : 'default'} href={`/admin/reports?tab=aging${scope}`} />
        <StatCard label="NPL ratio" value={percentOf(npl, classification.total.principal, 2)} hint="Substandard, doubtful and loss principal" icon={Scale} tone={npl > 0 ? 'destructive' : 'default'} href={`/admin/reports?tab=aging${scope}`} />
        <StatCard label="Available to lend" value={moneyCents(book.available, currency)} hint="Fund cash less reserved disbursements" icon={Wallet} href={`/admin/reports?tab=funds${scope}`} />
      </StatGrid>

      <section className="panel mt-6 p-4">
        <h2 className="text-sm font-semibold">Disbursed vs collected</h2>
        <p className="text-xs text-muted-foreground">{overview.granularity === 'day' ? 'Daily' : 'Monthly'} totals</p>
        <div className="mt-3">
          <TrendChart data={trend} currency={currency} />
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Show as table</summary>
          <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-border bg-secondary text-left">
                <tr>
                  <th className="px-3 py-2 font-semibold">{overview.granularity === 'day' ? 'Date' : 'Month'}</th>
                  <th className="px-3 py-2 text-right font-semibold">Disbursed</th>
                  <th className="px-3 py-2 text-right font-semibold">Collected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {overview.trend.map((p) => (
                  <tr key={p.period}>
                    <td className="px-3 py-1.5">{p.period}</td>
                    <td className="num px-3 py-1.5 text-right">{moneyCents(p.disbursed)}</td>
                    <td className="num px-3 py-1.5 text-right">{moneyCents(p.collected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold">Asset classification</h2>
          <p className="text-xs text-muted-foreground">Outstanding balance of active loans by National Bank class, as of today</p>
          <table className="mt-3 w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Class</th>
                <th className="py-2 pr-3 text-right font-medium">Loans</th>
                <th className="py-2 pr-3 text-right font-medium">Outstanding</th>
                <th className="w-2/5 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {NBE_CLASSES.map((c) => {
                const cell = classification.classes[c.key];
                const share = classification.total.outstanding ? cell.outstanding / classification.total.outstanding : 0;
                return (
                  <tr key={c.key}>
                    <td className="py-2 pr-3">
                      {c.label}
                      <span className="block text-xs text-muted-foreground">{c.range}</span>
                    </td>
                    <td className="num py-2 pr-3 text-right">{cell.loans.toLocaleString()}</td>
                    <td className="num py-2 pr-3 text-right">{moneyCents(cell.outstanding)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        {/* One hue for one measure: bar length carries the share, the figure beside it the exact value. */}
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                        </div>
                        <span className="num w-12 text-right text-xs text-muted-foreground">{(share * 100).toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Received in the period</h2>
          <p className="text-xs text-muted-foreground">Posted receipts, split as they were allocated</p>
          <dl className="mt-3 space-y-2 text-sm">
            {[
              { label: 'Principal recovered', value: collected.principal },
              { label: 'Interest', value: collected.interest },
              { label: 'Service fees', value: collected.fee },
              { label: 'Penalties', value: collected.penalty },
              { label: 'Tax collected', value: collected.tax },
              { label: 'Overpayments held', value: collected.excess },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="num">{moneyCents(row.value)}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <dt className="font-medium">Income collected</dt>
              <dd className="num font-semibold">{moneyCents(income, currency)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="font-medium">Total received</dt>
              <dd className="num font-semibold">{moneyCents(collected.amount, currency)}</dd>
            </div>
          </dl>
        </section>
      </div>
    </>
  );
}
