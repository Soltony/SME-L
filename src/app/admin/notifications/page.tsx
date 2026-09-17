import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/session';
import { hasPermission, readableTabs } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { isSmsConfigured } from '@/lib/sms';
import { formatDateTime, normalizePhone } from '@/lib/format';
import { TEMPLATE_DEFINITIONS, TEMPLATES_BY_CODE } from '@/lib/notification-templates';
import { PageHeader } from '@/components/admin/page-header';
import { StatCard, StatGrid } from '@/components/admin/stat-card';
import { EmptyRow, FilterBar, Pager, TableCard } from '@/components/admin/data-shell';
import { FilterSubmit, SelectFilter, TextFilter } from '@/components/admin/filters';
import { NotificationTemplates } from '@/components/admin/notification-templates';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notifications' };

// Not StatusBadge: there SENT is a disbursement still in flight, here it is done.
const STATUSES = [
  { value: 'SENT', label: 'Sent', variant: 'success' },
  { value: 'FAILED', label: 'Failed', variant: 'destructive' },
  { value: 'SKIPPED', label: 'Skipped', variant: 'outline' },
] as const;

function DeliveryStatus({ status }: { status: string }) {
  const entry = STATUSES.find((s) => s.value === status);
  return <Badge variant={entry?.variant ?? 'secondary'}>{entry?.label ?? status}</Badge>;
}

const RECENT_DAYS = 30;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string; template?: string; phone?: string; from?: string; to?: string; page?: string }>;
}) {
  const user = (await getCurrentUser({ allowRefresh: false }))!;
  const params = await searchParams;
  const tabs = readableTabs(user, 'notifications');
  const can = (tab: string) => tabs.find((entry) => entry.tab === tab);

  if (tabs.length === 0) {
    return (
      <>
        <PageHeader title="Notifications" />
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Your role opens this page but none of its tabs. Ask an administrator to grant <strong>Templates</strong> or{' '}
          <strong>Delivery log</strong> under Notifications in Access Control.
        </div>
      </>
    );
  }

  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 50;
  // Provider staff see messages about their own provider's loans and applications only.
  const scope: Prisma.NotificationLogWhereInput = user.providerId ? { providerId: user.providerId } : {};
  const phone = params.phone?.trim();
  const where: Prisma.NotificationLogWhereInput = {
    ...scope,
    ...(STATUSES.some((s) => s.value === params.status) ? { status: params.status } : {}),
    // Unknown codes are ignored rather than matched, so a stale link shows everything instead of nothing.
    ...(params.template && TEMPLATES_BY_CODE.has(params.template) ? { template: params.template } : {}),
    ...(phone ? { recipient: { contains: normalizePhone(phone) || phone } } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: new Date(`${params.from}T00:00:00Z`) } : {}),
            ...(params.to ? { lte: new Date(`${params.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  };

  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
  const [settings, saved, counts, logs, total] = await Promise.all([
    getSettings(),
    can('templates') ? prisma.notificationTemplate.findMany() : [],
    prisma.notificationLog.groupBy({ by: ['status'], where: { ...scope, createdAt: { gte: since } }, _count: { _all: true } }),
    can('logs') ? prisma.notificationLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }) : [],
    can('logs') ? prisma.notificationLog.count({ where }) : 0,
  ]);

  const countOf = (status: string) => counts.find((c) => c.status === status)?._count._all ?? 0;
  const savedByCode = new Map(saved.map((row) => [row.code, row]));
  const templates = TEMPLATE_DEFINITIONS.map((definition) => {
    const row = savedByCode.get(definition.code);
    return {
      code: definition.code,
      name: definition.name,
      trigger: definition.trigger,
      bodyEn: row?.bodyEn ?? definition.bodyEn,
      bodyAm: row ? (row.bodyAm ?? '') : definition.bodyAm,
      active: row?.active ?? true,
      defaultEn: definition.bodyEn,
      defaultAm: definition.bodyAm,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });

  const defaultTab = can(params.tab ?? '') ? params.tab! : tabs[0].tab;
  const sinceIso = since.toISOString().slice(0, 10);
  const statusHref = (status: string) =>
    can('logs') ? `/admin/notifications?tab=logs&status=${status}&from=${sinceIso}` : undefined;
  const entityHref = (entity: string | null, id: string | null) => {
    if (!id) return null;
    if (entity === 'Loan' && hasPermission(user, 'loans', 'read')) return { href: `/admin/loans/${id}`, label: 'Loan' };
    if (entity === 'LoanApplication' && hasPermission(user, 'applications', 'read')) {
      return { href: `/admin/applications/${id}`, label: 'Application' };
    }
    return null;
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        description="The SMS messages borrowers receive, their wording, and a record of every one sent."
      />

      {!settings['notifications.enabled'] && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <strong>Borrower SMS is switched off</strong> in Settings → Notifications. Messages are logged as skipped and
          nothing reaches borrowers until it is switched back on.
        </div>
      )}
      {settings['notifications.enabled'] && !isSmsConfigured() && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <strong>No SMS provider is configured.</strong> Set <code>SMS_API_URL</code> on the server; until then every
          message is logged as failed.
        </div>
      )}

      <StatGrid>
        <StatCard label={`Sent · ${RECENT_DAYS} days`} value={countOf('SENT')} tone="success" href={statusHref('SENT')} />
        <StatCard label={`Failed · ${RECENT_DAYS} days`} value={countOf('FAILED')} tone="destructive" href={statusHref('FAILED')} />
        <StatCard label={`Skipped · ${RECENT_DAYS} days`} value={countOf('SKIPPED')} tone="warning" href={statusHref('SKIPPED')} />
        <StatCard
          label="Messages switched on"
          value={`${templates.filter((t) => t.active).length} of ${templates.length}`}
          hint={`SMS language: ${settings['notifications.language'] === 'am' ? 'Amharic' : 'English'}`}
        />
      </StatGrid>

      <Tabs defaultValue={defaultTab} className="mt-6">
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.tab} value={tab.tab}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {can('templates') && (
          <TabsContent value="templates" className="mt-4">
            <NotificationTemplates
              templates={templates}
              canUpdate={Boolean(can('templates')?.canUpdate) && !user.providerId}
              language={String(settings['notifications.language'])}
              platformName={String(settings['platform.name'] || 'SME Lending')}
            />
          </TabsContent>
        )}

        {can('logs') && (
          <TabsContent value="logs" className="mt-4">
            <FilterBar>
              <input type="hidden" name="tab" value="logs" />
              <SelectFilter name="status" label="Status" value={params.status} options={STATUSES.map(({ value, label }) => ({ value, label }))} />
              <SelectFilter
                name="template"
                label="Message"
                value={params.template}
                options={TEMPLATE_DEFINITIONS.map((d) => ({ value: d.code, label: d.name }))}
              />
              <TextFilter name="phone" label="Phone" value={params.phone} placeholder="09…" />
              <TextFilter name="from" label="From" type="date" value={params.from} />
              <TextFilter name="to" label="To" type="date" value={params.to} />
              <FilterSubmit />
            </FilterBar>
            <TableCard>
              <table className="w-full min-w-[980px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">Message</th>
                    <th className="px-4 py-2.5 font-semibold">Recipient</th>
                    <th className="px-4 py-2.5 font-semibold">Text</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {logs.length === 0 && <EmptyRow colSpan={5} message="No messages match." />}
                  {logs.map((log) => {
                    const link = entityHref(log.entity, log.entityId);
                    return (
                      <tr key={log.id} className="align-top">
                        <td className="whitespace-nowrap px-4 py-2 text-xs">{formatDateTime(log.createdAt)}</td>
                        <td className="px-4 py-2">
                          <p className="font-medium">{TEMPLATES_BY_CODE.get(log.template)?.name ?? log.template}</p>
                          {link && (
                            <Link href={link.href} className="text-xs text-primary hover:underline">
                              {link.label}
                            </Link>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{log.recipient}</td>
                        <td className="max-w-[420px] px-4 py-2 text-xs">
                          <p className="text-muted-foreground">{log.body}</p>
                          {log.error && <p className="mt-1 text-destructive">{log.error}</p>}
                        </td>
                        <td className="px-4 py-2">
                          <DeliveryStatus status={log.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pager
                page={page}
                pageSize={pageSize}
                total={total}
                basePath="/admin/notifications"
                params={{ tab: 'logs', status: params.status, template: params.template, phone: params.phone, from: params.from, to: params.to }}
              />
            </TableCard>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
