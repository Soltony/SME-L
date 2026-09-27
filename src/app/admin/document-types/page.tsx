import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission } from '@/lib/permissions';
import { DOCUMENT_KIND_KEYS, DOCUMENT_KINDS, type DocumentKind } from '@/lib/document-kinds';
import { parseDocumentTypeIds } from '@/lib/lending/document-requirements';
import { PageHeader } from '@/components/admin/page-header';
import { ActionDialog, type ActionField } from '@/components/admin/action-dialog';
import { EmptyRow, TableCard } from '@/components/admin/data-shell';
import { StatusBadge } from '@/components/admin/status-badge';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Document types' };

const yesNo = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Yes — the borrower gives the date; expired documents stop counting' },
];

const kindOptions = DOCUMENT_KIND_KEYS.map((kind) => ({ value: kind, label: DOCUMENT_KINDS[kind].label }));

function detailFields(defaults?: { name: string; description: string; requiresExpiry: boolean; status: string; sortOrder: number }): ActionField[] {
  return [
    { name: 'name', label: 'Name shown to borrowers', required: true, defaultValue: defaults?.name ?? '', placeholder: 'Trade licence' },
    { name: 'description', label: 'Help text (optional)', type: 'textarea', defaultValue: defaults?.description ?? '', placeholder: 'The current year’s licence, all pages.' },
    { name: 'requiresExpiry', label: 'Ask for the expiry date', type: 'select', defaultValue: String(defaults?.requiresExpiry ?? false), options: yesNo },
    ...(defaults
      ? [
          {
            name: 'status',
            label: 'Status',
            type: 'select' as const,
            defaultValue: defaults.status,
            options: [
              { value: 'ACTIVE', label: 'Active — asked for' },
              { value: 'INACTIVE', label: 'Inactive — no longer asked for' },
            ],
          },
        ]
      : []),
    { name: 'sortOrder', label: 'Display order', type: 'number', defaultValue: String(defaults?.sortOrder ?? 0) },
  ];
}

export default async function DocumentTypesPage() {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const providerScope = user.providerId ? { id: user.providerId } : {};

  const [types, providers, products, pending] = await Promise.all([
    prisma.documentType.findMany({
      where: user.providerId ? { OR: [{ scope: 'GLOBAL' }, { providerId: user.providerId }] } : {},
      include: {
        provider: { select: { name: true } },
        _count: { select: { documents: { where: { status: 'APPROVED' } } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.loanProvider.findMany({ where: providerScope, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.loanProduct.findMany({
      where: user.providerId ? { providerId: user.providerId } : {},
      select: { name: true, status: true, documentTypeIds: true },
    }),
    prisma.pendingChange.count({
      where: { entityType: 'DocumentType', status: 'PENDING', ...(user.providerId ? { providerId: user.providerId } : {}) },
    }),
  ]);

  const usedBy = (typeId: string) => products.filter((p) => parseDocumentTypeIds(p.documentTypeIds).includes(typeId));
  const canCreate = hasPermission(user, 'document-types', 'create');
  const canUpdate = hasPermission(user, 'document-types', 'update');
  const bank = types.filter((t) => t.scope === 'GLOBAL');
  const own = types.filter((t) => t.scope === 'PRODUCT');

  const kindLabel = (kind: string) => DOCUMENT_KINDS[kind as DocumentKind]?.label ?? kind;
  const editButton = (t: (typeof types)[number]) =>
    canUpdate && (t.scope === 'PRODUCT' || !user.providerId) ? (
      <ActionDialog
        label="Edit"
        variant="ghost"
        title={`Edit ${t.name}`}
        description="What the borrower provides, and who it belongs to, cannot change — create a new type for that. Documents already approved keep their approval."
        endpoint={`/api/admin/document-types/${t.id}`}
        submitLabel="Send for approval"
        fields={detailFields({ name: t.name, description: t.description, requiresExpiry: t.requiresExpiry, status: t.status, sortOrder: t.sortOrder })}
      />
    ) : null;

  return (
    <>
      <PageHeader
        title="Document types"
        description="What borrowers provide before they can apply. The bank's documents are asked of everyone and reviewed by bank staff; a provider's documents are asked for by the products that list them and reviewed by that provider's staff. Changes need approval."
        actions={
          canCreate ? (
            <>
              {!user.providerId && (
                <ActionDialog
                  label="New bank document"
                  title="New bank document"
                  description="Asked of every borrower, for every product, once approved. Reviewed by bank staff."
                  endpoint="/api/admin/document-types"
                  extra={{ scope: 'GLOBAL' }}
                  submitLabel="Send for approval"
                  fields={[{ name: 'kind', label: 'Borrower provides', type: 'select', defaultValue: 'FILE', options: kindOptions }, ...detailFields()]}
                />
              )}
              {providers.length > 0 && (
                <ActionDialog
                  label="New provider document"
                  variant="default"
                  title="New provider document"
                  description="Asked for only by the provider's products that list it. Reviewed by the provider's own staff."
                  endpoint="/api/admin/document-types"
                  extra={{ scope: 'PRODUCT' }}
                  submitLabel="Send for approval"
                  fields={[
                    { name: 'providerId', label: 'Provider', type: 'select', defaultValue: providers[0].id, options: providers.map((p) => ({ value: p.id, label: p.name })) },
                    { name: 'kind', label: 'Borrower provides', type: 'select', defaultValue: 'FILE', options: kindOptions },
                    ...detailFields(),
                  ]}
                />
              )}
            </>
          ) : null
        }
      />

      {pending > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          {pending === 1 ? 'A document type change is' : `${pending} document type changes are`} waiting for approval.
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold">Bank documents — required from every borrower</h2>
      <TableCard className="mb-6">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Document</th>
              <th className="px-4 py-2.5 font-semibold">Borrower provides</th>
              <th className="px-4 py-2.5 font-semibold">Expiry date</th>
              <th className="px-4 py-2.5 text-right font-semibold">Approved on file</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {bank.length === 0 && <EmptyRow colSpan={6} message="No bank documents. Borrowers are asked only for what each product lists." />}
            {bank.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2.5">
                  <p className="font-medium">{t.name}</p>
                  {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                </td>
                <td className="px-4 py-2.5">{kindLabel(t.kind)}</td>
                <td className="px-4 py-2.5">{t.requiresExpiry ? 'Asked' : '—'}</td>
                <td className="num px-4 py-2.5 text-right">{t._count.documents.toLocaleString('en-US')}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-2.5 text-right">{editButton(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <h2 className="mb-2 text-sm font-semibold">Provider documents — asked for by the products that list them</h2>
      <TableCard>
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-border bg-secondary/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Document</th>
              {!user.providerId && <th className="px-4 py-2.5 font-semibold">Provider</th>}
              <th className="px-4 py-2.5 font-semibold">Borrower provides</th>
              <th className="px-4 py-2.5 font-semibold">Expiry date</th>
              <th className="px-4 py-2.5 font-semibold">Asked for by</th>
              <th className="px-4 py-2.5 text-right font-semibold">Approved on file</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {own.length === 0 && <EmptyRow colSpan={user.providerId ? 7 : 8} message="No provider documents yet." />}
            {own.map((t) => {
              const using = usedBy(t.id);
              return (
                <tr key={t.id}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{t.name}</p>
                    {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                  </td>
                  {!user.providerId && <td className="px-4 py-2.5">{t.provider?.name ?? '—'}</td>}
                  <td className="px-4 py-2.5">{kindLabel(t.kind)}</td>
                  <td className="px-4 py-2.5">{t.requiresExpiry ? 'Asked' : '—'}</td>
                  <td className="px-4 py-2.5 text-xs">{using.length ? using.map((p) => p.name).join(', ') : <span className="text-muted-foreground">No product yet</span>}</td>
                  <td className="num px-4 py-2.5 text-right">{t._count.documents.toLocaleString('en-US')}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right">{editButton(t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
