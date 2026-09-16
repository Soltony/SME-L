import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';
import { parseColumns } from '@/lib/data-provisioning';
import { HISTORY_FIELDS } from '@/lib/lending/eligibility';
import { PageHeader } from '@/components/admin/page-header';
import { FilterBar } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter } from '@/components/admin/filters';
import { ScoringEditor } from '@/components/admin/scoring-editor';
import { NewDataSet, UploadData } from '@/components/admin/data-sets';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Credit Scoring' };

export default async function CreditScoringPage({ searchParams }: { searchParams: Promise<{ providerId?: string }> }) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const providers = await prisma.loanProvider.findMany({
    where: user.providerId ? { id: user.providerId } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const providerId = user.providerId ?? (providers.some((p) => p.id === params.providerId) ? params.providerId! : providers[0]?.id);

  if (!providerId) {
    return (
      <>
        <PageHeader title="Credit Scoring" />
        <div className="panel p-6 text-sm text-muted-foreground">Create a provider first.</div>
      </>
    );
  }

  const [parameters, configs, pending] = await Promise.all([
    prisma.scoringParameter.findMany({ where: { providerId }, orderBy: { sortOrder: 'asc' }, include: { rules: true } }),
    prisma.dataProvisioningConfig.findMany({
      where: { providerId },
      include: {
        uploads: { orderBy: { createdAt: 'desc' }, take: 3 },
        _count: { select: { rows: true } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.pendingChange.count({ where: { entityType: 'ScoringModel', entityId: providerId, status: 'PENDING' } }),
  ]);

  const fields = Array.from(
    new Set([...configs.flatMap((c) => parseColumns(c.columns).filter((col) => !col.isIdentifier).map((col) => col.name)), ...HISTORY_FIELDS])
  );

  return (
    <>
      <PageHeader
        title="Credit Scoring"
        description="Each provider scores borrowers with its own weighted rules. The score picks the product's amount tier. Model changes need approval."
      />
      {!user.providerId && providers.length > 1 && (
        <FilterBar>
          <SelectFilter name="providerId" label="Provider" value={providerId} allLabel="Choose…" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          <FilterSubmit />
        </FilterBar>
      )}
      {pending > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">A change to this model is waiting for approval.</div>
      )}

      <ScoringEditor
        key={providerId}
        providerId={providerId}
        fields={fields}
        canSubmit={hasPermission(user, 'credit-scoring', 'update')}
        initial={parameters.map((p) => ({
          name: p.name,
          weight: String(p.weight),
          rules: p.rules.map((r) => ({ field: r.field, operator: r.operator, value: r.value, score: String(r.score) })),
        }))}
      />

      <div className="mb-3 mt-8 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Borrower data sets</h2>
          <p className="text-sm text-muted-foreground">
            Spreadsheets of borrower attributes the rules can use. Built-in history fields: {HISTORY_FIELDS.join(', ')}.
          </p>
        </div>
        {hasPermission(user, 'credit-scoring', 'create') && <NewDataSet providerId={providerId} />}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {configs.length === 0 && <div className="panel p-4 text-sm text-muted-foreground">No data sets yet.</div>}
        {configs.map((config) => {
          const columns = parseColumns(config.columns);
          return (
            <section key={config.id} className="panel p-4 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{config.name}</h3>
                  <p className="text-xs text-muted-foreground">{config._count.rows.toLocaleString()} borrowers on file</p>
                </div>
                {hasPermission(user, 'credit-scoring', 'create') && <UploadData configId={config.id} />}
              </div>
              <p className="mt-2 text-xs">
                {columns.map((c) => (
                  <span key={c.name} className="mr-1 inline-block rounded bg-secondary px-1.5 py-0.5">
                    {c.name} <span className="text-muted-foreground">({c.isIdentifier ? 'phone' : c.type})</span>
                  </span>
                ))}
              </p>
              {config.uploads.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {config.uploads.map((u) => (
                    <li key={u.id}>
                      {formatDateTime(u.createdAt)} · {u.fileName} · {u.acceptedRows}/{u.totalRows} rows
                      {u.rejectedRows > 0 && <span className="text-destructive"> · {u.rejectedRows} rejected</span>} · {u.uploadedBy}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
