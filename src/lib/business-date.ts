/**
 * The business calendar.
 *
 * A loan's life is counted in whole days: a day of interest, a due date, a day
 * past due. The previous system used `startOfDay(new Date())`, which is
 * midnight in whatever timezone the server process happens to run in — so the
 * same repayment could land on a different day, and accrue a different amount,
 * depending on the host. Here a business day is an integer (days since
 * 1970-01-01) in one declared timezone, and a date column is written and read
 * as UTC midnight of that day, which SQL Server's `date` type stores exactly.
 */

export type Day = number;

const MS_PER_DAY = 86_400_000;

/** Ethiopia is UTC+3 with no daylight saving; override for other markets. */
export function businessOffsetMinutes(): number {
  const configured = Number(process.env.BUSINESS_UTC_OFFSET_MINUTES);
  if (Number.isFinite(configured) && Math.abs(configured) <= 14 * 60) return configured;
  return 180;
}

/**
 * Today in the business calendar.
 *
 * `BUSINESS_DATE_OVERRIDE` pins "today" so QA can walk a loan through its due
 * date and into arrears without waiting. It is refused in production: moving
 * the calendar there would post accruals for days that have not happened.
 */
export function today(now: Date = new Date()): Day {
  const override = process.env.BUSINESS_DATE_OVERRIDE?.trim();
  if (override) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BUSINESS_DATE_OVERRIDE must not be set in production.');
    }
    return isoToDay(override);
  }
  return Math.floor((now.getTime() + businessOffsetMinutes() * 60_000) / MS_PER_DAY);
}

/** A `@db.Date` value (UTC midnight) → business day. */
export function dayFromDate(date: Date): Day {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** Business day → the Date Prisma should write to a `@db.Date` column. */
export function dateFromDay(day: Day): Date {
  return new Date(day * MS_PER_DAY);
}

export function addDays(day: Day, days: number): Day {
  return day + days;
}

export function dayToIso(day: Day): string {
  return dateFromDay(day).toISOString().slice(0, 10);
}

export function isoToDay(iso: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) throw new Error(`Not a YYYY-MM-DD date: "${iso}"`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = ms / MS_PER_DAY;
  if (dayToIso(day) !== iso.trim()) throw new Error(`Not a real calendar date: "${iso}"`);
  return day;
}

/** Parses an optional query-string date, or returns the fallback. */
export function parseIsoDay(value: string | null | undefined, fallback: Day): Day {
  if (!value) return fallback;
  try {
    return isoToDay(value);
  } catch {
    return fallback;
  }
}

export function formatDay(day: Day | null | undefined): string {
  if (day === null || day === undefined) return '—';
  return dateFromDay(day).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
