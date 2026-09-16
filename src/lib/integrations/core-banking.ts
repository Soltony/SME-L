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

async function postJson(url: string, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
  accountName: string | null;
  status: string | null;
}

/** Accounts core banking holds for this phone number. */
export async function fetchCustomerAccounts(phone: string): Promise<{ accounts: CbsAccount[]; simulated: boolean }> {
  if (isCbsSimulated()) {
    const tail = phone.replace(/\D/g, '').slice(-8).padStart(8, '0');
    return {
      simulated: true,
      accounts: [
        { accountNumber: `1000${tail}`, accountName: 'Savings account (simulated)', status: 'ACTIVE' },
        { accountNumber: `2000${tail}`, accountName: 'Current account (simulated)', status: 'ACTIVE' },
      ],
    };
  }

  const url = env('CBS_ACCOUNTS_URL', 'EXTERNAL_API_URL');
  if (!url) throw new CoreBankingError('The account lookup service is not configured.');

  const { response, json } = await postJson(url, { phoneNumber: phoneForCbs(phone) });
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
