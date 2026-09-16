/**
 * Money as integer minor units.
 *
 * Every amount that takes part in arithmetic is an integer count of santim
 * (1 ETB = 100 santim). JavaScript numbers hold integers exactly up to 2^53,
 * which is about 90 trillion ETB — far beyond any portfolio — so ordinary
 * addition and subtraction are exact. Multiplication by a rate is the one
 * operation that needs care, and it goes through `mulDivRound`, which works in
 * BigInt so the intermediate product can never lose precision.
 *
 * Decimal strings are parsed digit by digit rather than through `Number()`:
 * `Number('0.285') * 100` is 28.499999999999996, which is exactly the kind of
 * drift the previous system accumulated into its ledgers.
 */

export type Cents = number;

/** Anything a Prisma Decimal column, a JSON body or a form can hand us. */
export type DecimalInput =
  | string
  | number
  | bigint
  | { toString(): string }
  | null
  | undefined;

export class MoneyError extends Error {}

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal to an integer scaled by 10^scale, rounding half away from
 * zero on the first dropped digit. `parseScaled('12.345', 2)` → 1235.
 */
export function parseScaled(value: DecimalInput, scale: number): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value) * 10 ** scale;

  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`Not a finite amount: ${value}`);
    // Shortest round-trip representation, then exact decimal parsing. Numbers
    // too large or small for plain notation are not amounts we accept.
    text = String(value);
    if (/e/i.test(text)) text = value.toFixed(Math.min(20, scale + 2));
  } else {
    text = String(value).trim();
  }

  if (text === '') return 0;
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) throw new MoneyError(`Not a decimal amount: "${text}"`);

  const [, sign, whole, fraction = ''] = match;
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const firstDropped = fraction.length > scale ? Number(fraction[scale]) : 0;

  let result = BigInt(whole + kept);
  if (firstDropped >= 5) result += 1n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(`Amount out of range: "${text}"`);
  }
  const n = Number(result);
  return sign === '-' && n !== 0 ? -n : n;
}

/** Decimal → cents. */
export function toCents(value: DecimalInput): Cents {
  return parseScaled(value, 2);
}

/** Cents → the exact decimal string a Prisma Decimal column accepts. */
export function centsToDecimal(cents: Cents): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Cents → a plain number of currency units, for JSON view models only. */
export function centsToNumber(cents: Cents): number {
  return cents / 100;
}

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount must be a whole number of minor units, got ${value}`);
  }
}

/**
 * round(a × numerator ÷ denominator), half away from zero, computed exactly.
 * The only way rates are applied to money in this codebase.
 */
export function mulDivRound(a: number, numerator: number, denominator: number): number {
  if (denominator === 0) throw new MoneyError('Division by zero');
  const product = BigInt(a) * BigInt(numerator);
  const d = BigInt(denominator);
  const negative = product < 0n !== d < 0n;
  const absProduct = product < 0n ? -product : product;
  const absD = d < 0n ? -d : d;
  let quotient = absProduct / absD;
  if ((absProduct % absD) * 2n >= absD) quotient += 1n;
  const n = Number(quotient);
  return negative && n !== 0 ? -n : n;
}

/**
 * Rates are carried as micro-percent integers: 1.5% → 1_500_000. Six decimal
 * places of a percent is what the Decimal(18,6) rate columns hold, so nothing
 * an operator can store is lost on the way in.
 */
export const RATE_SCALE = 1_000_000;

export function toRateMicro(value: DecimalInput): number {
  return parseScaled(value, 6);
}

/** amount × rate%, rounded to the cent. */
export function applyRate(amount: Cents, rateMicro: number): Cents {
  if (!amount || !rateMicro) return 0;
  return mulDivRound(amount, rateMicro, 100 * RATE_SCALE);
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function formatMoney(cents: Cents, currency = 'ETB'): string {
  const value = cents / 100;
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

/** Plain formatting for a decimal that is already in currency units. */
export function formatAmount(value: DecimalInput, currency = 'ETB'): string {
  return formatMoney(toCents(value), currency);
}

/**
 * Reads a user-entered amount: positive, at most two decimals, and nothing a
 * browser's number coercion would quietly repair. Returns null when invalid.
 */
export function parseUserAmount(raw: unknown): Cents | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  try {
    const cents = toCents(text);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}
