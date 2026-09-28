import { dateFromDay, dayFromDate, dayToIso, isoToDay, type Day } from './business-date';
import type { LoanTerms } from './lending/terms';

/**
 * The pure parts of the reports: classification, reporting periods, trend
 * buckets and the wording regulators expect. Nothing here touches the database,
 * so all of it is unit-tested.
 */

/**
 * National Bank of Ethiopia asset classification by days past due. Every active
 * loan is classified — performing loans are Pass — so the classes add up to the
 * whole book, not just its arrears.
 */
export const NBE_CLASSES = [
  { key: 'PASS', label: 'Pass', range: '0–29 days', min: 0, max: 29 },
  { key: 'SPECIAL_MENTION', label: 'Special mention', range: '30–89 days', min: 30, max: 89 },
  { key: 'SUBSTANDARD', label: 'Substandard', range: '90–179 days', min: 90, max: 179 },
  { key: 'DOUBTFUL', label: 'Doubtful', range: '180–359 days', min: 180, max: 359 },
  { key: 'LOSS', label: 'Loss', range: '360+ days', min: 360, max: Number.POSITIVE_INFINITY },
] as const;

export type NbeClass = (typeof NBE_CLASSES)[number]['key'];

/** The classes the National Bank counts as non-performing. */
export const NON_PERFORMING_CLASSES: readonly NbeClass[] = ['SUBSTANDARD', 'DOUBTFUL', 'LOSS'];

export function classifyNbe(daysPastDue: number): NbeClass {
  const days = Math.max(0, daysPastDue);
  return (NBE_CLASSES.find((c) => days >= c.min && days <= c.max) ?? NBE_CLASSES[NBE_CLASSES.length - 1]).key;
}

export function nbeLabel(key: string): string {
  return NBE_CLASSES.find((c) => c.key === key)?.label ?? key;
}

export function isNbeClass(value: string | null | undefined): value is NbeClass {
  return NBE_CLASSES.some((c) => c.key === value);
}

// ----------------------------------------
// Reporting periods
// ----------------------------------------

export interface ReportPeriod {
  key: string;
  label: string;
  from: Day;
  to: Day;
}

function firstOfMonth(year: number, monthIndex: number): Day {
  return dayFromDate(new Date(Date.UTC(year, monthIndex, 1)));
}

/**
 * The quick ranges above the date inputs. Periods run to today rather than to
 * the end of the week or month, so a report never shows days that have not
 * happened yet. Weeks start on Monday.
 */
export function reportPeriods(today: Day): ReportPeriod[] {
  const date = dateFromDay(today);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const weekday = (date.getUTCDay() + 6) % 7;
  const quarterStart = Math.floor(month / 3) * 3;
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'week', label: 'This week', from: today - weekday, to: today },
    { key: 'last30', label: 'Last 30 days', from: today - 30, to: today },
    { key: 'month', label: 'This month', from: firstOfMonth(year, month), to: today },
    { key: 'lastMonth', label: 'Last month', from: firstOfMonth(year, month - 1), to: firstOfMonth(year, month) - 1 },
    { key: 'quarter', label: 'This quarter', from: firstOfMonth(year, quarterStart), to: today },
    { key: 'half', label: 'This half-year', from: firstOfMonth(year, month < 6 ? 0 : 6), to: today },
    { key: 'year', label: 'This year', from: firstOfMonth(year, 0), to: today },
  ];
}

// ----------------------------------------
// Trend series
// ----------------------------------------

export type TrendGranularity = 'day' | 'month';

/** Daily points up to about two months; beyond that a daily series is unreadable. */
export function trendGranularity(from: Day, to: Day): TrendGranularity {
  return to - from <= 62 ? 'day' : 'month';
}

/** The bucket a day falls in: YYYY-MM-DD for daily series, YYYY-MM for monthly. */
export function trendKey(day: Day, granularity: TrendGranularity): string {
  const iso = dayToIso(day);
  return granularity === 'day' ? iso : iso.slice(0, 7);
}

/** Every bucket from `from` to `to`, oldest first, so empty days still show as zero. */
export function trendKeys(from: Day, to: Day, granularity: TrendGranularity): string[] {
  if (granularity === 'day') {
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => dayToIso(from + i));
  }
  const keys: string[] = [];
  let cursor = isoToDay(`${dayToIso(from).slice(0, 7)}-01`);
  while (cursor <= to) {
    const key = dayToIso(cursor).slice(0, 7);
    keys.push(key);
    const d = dateFromDay(cursor);
    cursor = firstOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  return keys;
}

// ----------------------------------------
// Regulatory wording
// ----------------------------------------

/**
 * First, father's and grandfather's name — the Ethiopian convention the National
 * Bank's register asks for. A two-part name has no middle name; anything past
 * the third part stays with the last name.
 */
export function splitFullName(fullName: string | null | undefined): [string, string, string] {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 3) return [parts[0], parts[1], parts.slice(2).join(' ')];
  if (parts.length === 2) return [parts[0], '', parts[1]];
  return [parts[0] ?? '', '', ''];
}

/** How often a loan is repaid, from its term and number of installments. */
export function repaymentFrequency(durationDays: number, installmentCount: number): string {
  if (installmentCount <= 1) return 'Single payment';
  const interval = durationDays / installmentCount;
  if (interval <= 7) return 'Weekly';
  if (interval <= 15) return 'Fortnightly';
  if (interval <= 31) return 'Monthly';
  if (interval <= 92) return 'Quarterly';
  return `Every ${Math.round(interval)} days`;
}

/** The interest a loan was granted at, as its terms state it. */
export function describeInterest(terms: Pick<LoanTerms, 'interest' | 'currency'>): string {
  const { type, value, basis } = terms.interest;
  if (type === 'NONE') return 'None';
  const compound = basis === 'COMPOUND' ? ', compound' : '';
  if (type === 'PERCENT_DAILY') return `${value}% per day${compound}`;
  return `${terms.currency} ${value} per day`;
}

/** The service fee a loan was granted with, as its terms state it. */
export function describeServiceFee(terms: Pick<LoanTerms, 'serviceFee' | 'currency'>): string {
  const { type, value } = terms.serviceFee;
  if (type === 'NONE') return 'None';
  if (type === 'PERCENT') return `${value}%`;
  return `${terms.currency} ${value}`;
}
