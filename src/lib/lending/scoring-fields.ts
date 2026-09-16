/**
 * Every field a scoring rule may use, in one list.
 *
 * Rules used to name their field in free text, matched against whatever keys
 * the borrower's data happened to have. A typo, or a column renamed in next
 * month's upload, silently scored everyone zero. Now a parameter is chosen
 * from this list, and a model naming anything else cannot be saved or approved.
 *
 * Three sources:
 *  - core banking: the account holder's profile and six months of account
 *    activity, fetched per borrower and cached (see `core-banking-profile.ts`);
 *  - loan history on this platform;
 *  - the provider's own uploaded data sets.
 *
 * Deliberately left out of core banking: name, national ID, mother's name,
 * address lines, gender and marital status. The first are identifiers, not
 * credit signals; scoring on the last two is discrimination the platform
 * should not make easy.
 *
 * Free of server imports, so the editor uses the same list.
 */

import { normalizeFieldName, type ScoringOperator } from './scoring';

export type ScoringFieldType = 'number' | 'text';
export type ScoringFieldSource = 'CORE_BANKING' | 'HISTORY' | 'DATA_SET';

export interface ScoringField {
  key: string;
  label: string;
  group: string;
  source: ScoringFieldSource;
  type: ScoringFieldType;
  unit?: string;
  help?: string;
  /** Known values of a text field, offered as choices. */
  options?: string[];
}

export const CORE_BANKING_PROFILE_GROUP = 'Core banking — customer profile';
export const CORE_BANKING_ACTIVITY_GROUP = 'Core banking — account activity (last 6 months)';
export const HISTORY_GROUP = 'Loan history on this platform';

export const CORE_BANKING_FIELDS: ScoringField[] = [
  { key: 'netMonthlyIncome', label: 'Net monthly income', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'ETB', help: 'As recorded by the bank.' },
  { key: 'ageYears', label: 'Age', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'years' },
  { key: 'accountAgeMonths', label: 'Time banking with us', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'months', help: 'Since the oldest account was opened.' },
  { key: 'occupation', label: 'Occupation', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'text' },
  { key: 'region', label: 'Region', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'text' },
  { key: 'city', label: 'City', group: CORE_BANKING_PROFILE_GROUP, source: 'CORE_BANKING', type: 'text' },
  { key: 'avgMonthlyDeposit', label: 'Typical monthly deposits', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'ETB', help: 'Money in per month across all accounts — the median, so one unusual month does not skew it.' },
  { key: 'avgMonthlyWithdrawal', label: 'Typical monthly withdrawals', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'ETB', help: 'The median month.' },
  { key: 'avgBalance', label: 'Average balance', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'ETB', help: 'Average month-end balance, across all accounts.' },
  { key: 'lowestBalance', label: 'Lowest month-end balance', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'ETB' },
  { key: 'activeMonths', label: 'Months with deposits', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: 'of 6' },
  { key: 'depositCount', label: 'Number of deposits', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number' },
  { key: 'depositSources', label: 'Different payers', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', help: 'Distinct senders of deposits — many customers rather than one.' },
  { key: 'withdrawalToDepositPercent', label: 'Withdrawals as % of deposits', group: CORE_BANKING_ACTIVITY_GROUP, source: 'CORE_BANKING', type: 'number', unit: '%', help: 'Below 100 means money is building up.' },
];

export const HISTORY_FIELD_DEFS: ScoringField[] = [
  { key: 'disbursedLoans', label: 'Loans received', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'paidOffLoans', label: 'Loans repaid in full', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'onTimeLoans', label: 'Loans repaid on time or early', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'earlyLoans', label: 'Loans repaid early', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'lateLoans', label: 'Loans repaid late', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'writtenOffLoans', label: 'Loans written off', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'openLoans', label: 'Loans open now', group: HISTORY_GROUP, source: 'HISTORY', type: 'number' },
  { key: 'worstDaysPastDue', label: 'Most days ever overdue', group: HISTORY_GROUP, source: 'HISTORY', type: 'number', unit: 'days' },
];

export const HISTORY_FIELDS = HISTORY_FIELD_DEFS.map((f) => f.key);
export const CORE_BANKING_FIELD_KEYS = new Set(CORE_BANKING_FIELDS.map((f) => normalizeFieldName(f.key)));

export interface DataSetDefinition {
  name: string;
  columns: { name: string; type: string; isIdentifier: boolean }[];
}

/**
 * The fields a provider can score on. Built-in fields come first and win a
 * name clash with an uploaded column. Date columns are left out: no operator
 * here compares dates.
 */
export function buildFieldCatalogue(dataSets: DataSetDefinition[], options: Record<string, string[]> = {}): ScoringField[] {
  const out: ScoringField[] = [];
  const seen = new Set<string>();
  const add = (field: ScoringField) => {
    const key = normalizeFieldName(field.key);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const known = options[key];
    out.push(field.type === 'text' && known?.length ? { ...field, options: known } : field);
  };
  CORE_BANKING_FIELDS.forEach(add);
  HISTORY_FIELD_DEFS.forEach(add);
  for (const set of dataSets) {
    for (const column of set.columns) {
      if (column.isIdentifier || (column.type !== 'number' && column.type !== 'string')) continue;
      add({
        key: column.name,
        label: column.name,
        group: `Uploaded data — ${set.name}`,
        source: 'DATA_SET',
        type: column.type === 'number' ? 'number' : 'text',
      });
    }
  }
  return out;
}

export function findField(catalogue: ScoringField[], key: string): ScoringField | undefined {
  const wanted = normalizeFieldName(key);
  return catalogue.find((f) => normalizeFieldName(f.key) === wanted);
}

export const OPERATORS_BY_TYPE: Record<ScoringFieldType, ScoringOperator[]> = {
  number: ['>=', '>', '<=', '<', 'between', '==', '!='],
  text: ['==', '!=', 'in'],
};

/** Problems with a model's fields, as issue paths into `parameters`. */
export function modelFieldIssues(
  parameters: { field: string; rules: { operator: string }[] }[],
  catalogue: ScoringField[]
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  parameters.forEach((parameter, p) => {
    const field = findField(catalogue, parameter.field);
    if (!field) {
      issues.push({ path: [p, 'field'], message: `"${parameter.field}" is not a field this provider can score on. Choose one from the list.` });
      return;
    }
    parameter.rules.forEach((rule, r) => {
      if (!(OPERATORS_BY_TYPE[field.type] as string[]).includes(rule.operator)) {
        issues.push({
          path: [p, 'rules', r, 'operator'],
          message: field.type === 'text' ? `${field.label} is text: use "is", "is not" or "is one of".` : `${field.label} is a number: "is one of" does not apply.`,
        });
      }
    });
  });
  return issues;
}

/**
 * Parameters as the editor shows them: one field each. A model saved when a
 * parameter could mix fields is split, one parameter per field, each weighted
 * at its best rule so no rule is left worth more than its parameter.
 */
export function oneFieldPerParameter<R extends { field: string; score: number }>(
  parameters: { name: string; weight: number; rules: R[] }[]
): { parameters: { field: string; weight: number; rules: R[] }[]; split: boolean } {
  let split = false;
  const out: { field: string; weight: number; rules: R[] }[] = [];
  for (const parameter of parameters) {
    const byField = new Map<string, R[]>();
    for (const rule of parameter.rules) {
      const key = normalizeFieldName(rule.field);
      byField.set(key, [...(byField.get(key) ?? []), rule]);
    }
    if (byField.size <= 1) {
      out.push({ field: parameter.rules[0]?.field ?? parameter.name, weight: parameter.weight, rules: parameter.rules });
      continue;
    }
    split = true;
    for (const rules of byField.values()) {
      out.push({ field: rules[0].field, weight: Math.max(1, ...rules.map((r) => r.score)), rules });
    }
  }
  return { parameters: out, split };
}
