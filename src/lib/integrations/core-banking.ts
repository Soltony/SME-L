import { isCbsSimulated } from '@/lib/dev-switches';
import { toLocalPhone } from '@/lib/format';

/**
 * Core banking: which accounts belong to a phone number, and sending a loan's
 * money to one of them.
 *
 * Environment names from the previous SME deployment (EXTERNAL_API_URL,
 * EXTERNAL_DISBURSEMENT_URL, EXTERNAL_API_USERNAME/PASSWORD) are still read, so
 * an existing .env keeps working. Unlike before, nothing falls back to a
 * hard-coded credential: the old distribution job defaulted to
 * `nibLoan` / `123456` when the variables were missing.
 */

const TIMEOUT_MS = 20_000;

function env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function basicAuth(): string | undefined {
  const user = env('CBS_API_USERNAME', 'EXTERNAL_API_USERNAME');
  const pass = env('CBS_API_PASSWORD', 'EXTERNAL_API_PASSWORD');
  if (!user || !pass) return undefined;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function phoneForCbs(phone: string) {
  return process.env.CBS_PHONE_FORMAT === 'local' ? toLocalPhone(phone) : phone;
}

async function postJson(url: string, body: unknown, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const auth = basicAuth();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { response, text, json };
  } finally {
    clearTimeout(timer);
  }
}

export class CoreBankingError extends Error {}

export interface CbsAccount {
  accountNumber: string;
  /** The account holder's name, as the bank records it. */
  accountName: string | null;
  status: string | null;
}

/**
 * Accounts core banking holds for this phone number, each with its holder's
 * name. `timeoutMs` lets sign-in, which must not hang on a slow bank, give up
 * sooner than a refresh the borrower asked for.
 */
export async function fetchCustomerAccounts(
  phone: string,
  options: { timeoutMs?: number } = {}
): Promise<{ accounts: CbsAccount[]; simulated: boolean }> {
  if (isCbsSimulated()) {
    const tail = phone.replace(/\D/g, '').slice(-8).padStart(8, '0');
    // A person's name, as the real service returns — it becomes the borrower's name.
    const holder = `Test Customer ${tail.slice(-4)}`;
    return {
      simulated: true,
      accounts: [
        { accountNumber: `1000${tail}`, accountName: holder, status: 'ACTIVE' },
        { accountNumber: `2000${tail}`, accountName: holder, status: 'ACTIVE' },
      ],
    };
  }

  const url = env('CBS_ACCOUNTS_URL', 'EXTERNAL_API_URL');
  if (!url) throw new CoreBankingError('The account lookup service is not configured.');

  const { response, json } = await postJson(url, { phoneNumber: phoneForCbs(phone) }, options.timeoutMs);
  if (!response.ok) {
    throw new CoreBankingError(`Account lookup failed with status ${response.status}.`);
  }
  const details = (json as { details?: unknown })?.details;
  const list = Array.isArray(details) ? details : [];
  return {
    simulated: false,
    accounts: list
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          accountNumber: String(record.AccountNumber ?? record.accountNumber ?? '').trim(),
          accountName: (record.Name ?? record.accountName ?? null) as string | null,
          status: (record.Status ?? record.status ?? null) as string | null,
        };
      })
      .filter((a) => /^[0-9A-Za-z-]{4,34}$/.test(a.accountNumber))
      .filter((a) => !a.status || !/closed|dormant|blocked|inactive/i.test(a.status)),
  };
}

export type DisbursementOutcomeKind = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface DisbursementCallResult {
  outcome: DisbursementOutcomeKind;
  reference: string | null;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
}

/** Network failures that prove the request never reached core banking. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

/**
 * Sends one disbursement. The outcome is three-valued on purpose: a timeout or
 * a 5xx leaves us not knowing whether the money moved, and guessing either way
 * is how a borrower ends up owing a loan they never got — or getting paid twice.
 * UNKNOWN attempts wait for an operator to check core banking and resolve them.
 */
export async function sendDisbursement(input: {
  requestId: string;
  creditAccount: string;
  amount: string;
  providerCode: string;
  loanNumber: string;
}): Promise<DisbursementCallResult> {
  if (isCbsSimulated()) {
    return {
      outcome: 'SUCCEEDED',
      reference: `SIM-${input.requestId.slice(0, 8).toUpperCase()}`,
      httpStatus: 200,
      responseBody: JSON.stringify({ simulated: true }),
      errorMessage: null,
    };
  }

  const url = env('CBS_DISBURSEMENT_URL', 'EXTERNAL_DISBURSEMENT_URL');
  if (!url) {
    return {
      outcome: 'FAILED',
      reference: null,
      httpStatus: null,
      responseBody: null,
      errorMessage: 'Disbursement service is not configured.',
    };
  }

  try {
    const { response, text, json } = await postJson(url, {
      creditAccount: input.creditAccount,
      providerId: input.providerCode,
      amount: Number(input.amount),
      loanId: input.loanNumber,
      requestId: input.requestId,
    });
    const record = (json ?? {}) as Record<string, unknown>;
    const reference = (record.transactionId ?? record.transactionid ?? record.transaction_id ?? null) as
      | string
      | null;
    const outcome: DisbursementOutcomeKind = response.ok
      ? 'SUCCEEDED'
      : response.status >= 500
        ? 'UNKNOWN'
        : 'FAILED';
    return {
      outcome,
      reference: reference ? String(reference) : null,
      httpStatus: response.status,
      responseBody: text.slice(0, 4000),
      errorMessage: response.ok ? null : `Core banking responded ${response.status}.`,
    };
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code ?? '';
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: NOT_SENT_CODES.has(code) ? 'FAILED' : 'UNKNOWN',
      reference: null,
      httpStatus: null,
      responseBody: null,
      errorMessage: `${code || 'NETWORK'}: ${message}`.slice(0, 1000),
    };
  }
}

// ----------------------------------------
// Customer information and account statements, for credit scoring
// ----------------------------------------

/** What the customer-information service says about an account holder. Only what scoring uses is kept. */
export interface CbsCustomerInfo {
  netMonthlyIncome: number | null;
  /** YYYY-MM-DD, or null when missing or unreadable. */
  dateOfBirth: string | null;
  accountOpeningDate: string | null;
  occupation: string | null;
  region: string | null;
  city: string | null;
}

export interface CbsStatementLine {
  /** YYYY-MM-DD */
  date: string | null;
  credit: number;
  debit: number;
  balance: number | null;
  /** Who the money came from or went to, as the bank describes it. */
  counterparty: string | null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * A core-banking date as YYYY-MM-DD. The services are not consistent: the same
 * bank answers with 20250104, 2025-01-04, 04 JAN 25 and 04-JAN-2025.
 */
export function parseCbsDate(value: unknown): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return null;
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = text.match(/^(\d{1,2})[\s/-]([A-Z]{3})[A-Z]*[\s/-](\d{2}|\d{4})$/))) {
    const month = MONTHS.indexOf(match[2]);
    if (month === -1) return null;
    y = Number(match[3]);
    // A two-digit year that would be in the future is last century: "15 MAR 90" is a birth date in 1990.
    if (y < 100) y += 2000 + y > new Date().getUTCFullYear() ? 1900 : 2000;
    [m, d] = [month + 1, Number(match[1])];
  } else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function cbsNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[^0-9.-]+/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function cbsText(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 80) : null;
}

/** The fields of a customer-information response, whichever envelope it arrives in. */
export function parseCustomerInfo(json: unknown): CbsCustomerInfo {
  const root = (json ?? {}) as Record<string, unknown>;
  const detail = (root.detail ?? root.details ?? root) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (detail?.[key] !== undefined && detail[key] !== null) return detail[key];
    return null;
  };
  return {
    netMonthlyIncome: cbsNumber(pick('NetMonthlyIncome', 'netMonthlyIncome')),
    dateOfBirth: parseCbsDate(pick('DateOfBirth', 'dateOfBirth')),
    accountOpeningDate: parseCbsDate(pick('AccountOpeningDate', 'accountOpeningDate')),
    occupation: cbsText(pick('Occupation', 'occupation')),
    region: cbsText(pick('ResidenceRegion', 'residenceRegion', 'Region')),
    city: cbsText(pick('City', 'city')),
  };
}

/** The lines of a statement response, whichever envelope it arrives in. */
export function parseStatement(json: unknown): CbsStatementLine[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const details = (root.details ?? root.detail ?? root) as Record<string, unknown>;
  const rows = details?.statementDetails ?? (root as Record<string, unknown>).statementDetails;
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return {
      date: parseCbsDate(row.ValueDate ?? row.valueDate ?? row.BookDate ?? row.bookDate),
      credit: Math.max(0, cbsNumber(row.Credit ?? row.credit) ?? 0),
      debit: Math.abs(cbsNumber(row.Debit ?? row.debit) ?? 0),
      balance: cbsNumber(row.ClosingBalance ?? row.closingBalance),
      counterparty: cbsText(row.Reference ?? row.reference ?? row.Narrative ?? row.narrative ?? row.Description ?? row.description),
    };
  });
}

/** Deterministic per account, so a simulated borrower scores the same every time. */
function simulatedSeed(accountNumber: string) {
  return Number(accountNumber.replace(/\D/g, '').slice(-6) || '0');
}

export async function fetchCustomerInfo(accountNumber: string): Promise<CbsCustomerInfo> {
  if (isCbsSimulated()) {
    const seed = simulatedSeed(accountNumber);
    return {
      netMonthlyIncome: 8000 + (seed % 12) * 2500,
      dateOfBirth: `${1970 + (seed % 30)}-0${1 + (seed % 9)}-15`,
      accountOpeningDate: `${2012 + (seed % 12)}-0${1 + (seed % 9)}-01`,
      occupation: ['Trader', 'Farmer', 'Civil servant', 'Driver'][seed % 4],
      region: ['Addis Ababa', 'Oromia', 'Amhara', 'Sidama'][seed % 4],
      city: ['Addis Ababa', 'Adama', 'Bahir Dar', 'Hawassa'][seed % 4],
    };
  }
  const url = env('CBS_CUSTOMER_INFO_URL', 'EXTERNAL_CUSTOMER_INFO_URL');
  if (!url) throw new CoreBankingError('The customer information service is not configured.');
  const { response, json } = await postJson(url, { accountNumber });
  if (!response.ok) throw new CoreBankingError(`Customer information lookup failed with status ${response.status}.`);
  return parseCustomerInfo(json);
}

const yyyymmdd = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');

export async function fetchAccountStatement(accountNumber: string, from: Date, to: Date): Promise<CbsStatementLine[]> {
  if (isCbsSimulated()) {
    const seed = simulatedSeed(accountNumber);
    const lines: CbsStatementLine[] = [];
    let balance = 2000 + (seed % 7) * 1500;
    for (let month = 0; month < 6; month += 1) {
      const date = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - month, 10)).toISOString().slice(0, 10);
      const deposit = 6000 + (seed % 9) * 1800 + month * 250;
      balance += deposit;
      lines.push({ date, credit: deposit, debit: 0, balance, counterparty: `Customer ${1 + ((seed + month) % 5)}` });
      const spend = Math.round(deposit * (0.55 + (seed % 4) * 0.1));
      balance -= spend;
      lines.push({ date, credit: 0, debit: spend, balance, counterparty: 'Supplier' });
    }
    return lines;
  }
  const url = env('CBS_STATEMENT_URL', 'EXTERNAL_STATEMENT_URL');
  if (!url) throw new CoreBankingError('The account statement service is not configured.');
  const { response, json } = await postJson(url, { accountNumber, startDate: yyyymmdd(from), endDate: yyyymmdd(to) });
  if (!response.ok) throw new CoreBankingError(`Statement lookup failed with status ${response.status}.`);
  return parseStatement(json);
}
