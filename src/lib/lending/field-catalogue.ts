import type { TxClient } from '@/lib/db-lock';
import { parseColumns } from '@/lib/data-provisioning';
import { normalizeFieldName } from './scoring';
import { buildFieldCatalogue, CORE_BANKING_FIELDS, type ScoringField } from './scoring-fields';

/** Rows looked at when collecting the values a text field takes. */
const SAMPLE_ROWS = 2000;
/** More distinct values than this, and the field is typed rather than picked. */
const MAX_OPTIONS = 40;

function collect(target: Map<string, Map<string, string>>, key: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return;
  const text = value.trim();
  const values = target.get(key) ?? new Map<string, string>();
  if (values.size > MAX_OPTIONS) return;
  if (!values.has(text.toLowerCase())) values.set(text.toLowerCase(), text);
  target.set(key, values);
}

/**
 * Everything this provider's scoring rules may use, with the values each text
 * field has actually taken — so "Sector is one of …" is ticked from the sectors
 * in the uploads, not typed and hoped to match.
 */
export async function providerFieldCatalogue(client: TxClient, providerId: string): Promise<ScoringField[]> {
  const [configs, profiles] = await Promise.all([
    client.dataProvisioningConfig.findMany({ where: { providerId }, orderBy: { name: 'asc' }, select: { id: true, name: true, columns: true } }),
    client.borrowerCoreBankingProfile.findMany({ orderBy: { attemptedAt: 'desc' }, take: SAMPLE_ROWS, select: { values: true } }),
  ]);
  const dataSets = configs.map((c) => ({ name: c.name, columns: parseColumns(c.columns) }));
  const textKeys = new Set([
    ...CORE_BANKING_FIELDS.filter((f) => f.type === 'text').map((f) => normalizeFieldName(f.key)),
    ...dataSets.flatMap((s) => s.columns.filter((c) => c.type === 'string' && !c.isIdentifier).map((c) => normalizeFieldName(c.name))),
  ]);

  const found = new Map<string, Map<string, string>>();
  const take = (json: string) => {
    try {
      for (const [key, value] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
        const normalized = normalizeFieldName(key);
        if (textKeys.has(normalized)) collect(found, normalized, value);
      }
    } catch {
      // An unreadable row offers no values.
    }
  };
  profiles.forEach((p) => take(p.values));
  for (const config of configs) {
    const rows = await client.borrowerDataRow.findMany({
      where: { configId: config.id },
      orderBy: { updatedAt: 'desc' },
      take: SAMPLE_ROWS,
      select: { data: true },
    });
    rows.forEach((r) => take(r.data));
  }

  const options: Record<string, string[]> = {};
  for (const [key, values] of found) {
    if (values.size <= MAX_OPTIONS) options[key] = [...values.values()].sort((a, b) => a.localeCompare(b));
  }
  return buildFieldCatalogue(dataSets, options);
}
