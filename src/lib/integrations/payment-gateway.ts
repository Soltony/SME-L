import { createHash } from 'node:crypto';
import { secretsMatch } from '@/lib/secrets';
import { businessOffsetMinutes } from '@/lib/business-date';

/** yyyyMMddHHmmss in the business timezone, the format the gateway signs. */
export function gatewayTimestamp(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + businessOffsetMinutes() * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(shifted.getUTCFullYear()) +
    pad(shifted.getUTCMonth() + 1) +
    pad(shifted.getUTCDate()) +
    pad(shifted.getUTCHours()) +
    pad(shifted.getUTCMinutes()) +
    pad(shifted.getUTCSeconds())
  );
}

/**
 * Super-app payment gateway: wallet repayments.
 *
 * We sign the payment request with the merchant key; the gateway signs its
 * callback with the same key. The callback signature is the only part of a
 * callback a borrower cannot produce — the bearer token it carries is an
 * ordinary customer token, which every borrower holds. The previous SME
 * callback trusted that token alone, so a borrower could mark their own loan
 * repaid without paying. Ported from GuessLow, which uses the same gateway.
 */

export class PaymentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GatewayConfig {
  accountNo: string;
  companyName: string;
  callbackUrl: string;
  paymentUrl: string;
  key: string;
}

/**
 * PAYMENT_* names, falling back to the NIB_PAYMENT_* names SME used.
 *
 * `collectionAccountNo` is where the money should land — the loan's provider's
 * collection account. ACCOUNT_NO is the platform-wide account used when the
 * provider has none, and is only required in that case.
 */
export function resolveGatewayConfig(
  collectionAccountNo?: string | null
): { config: GatewayConfig | null; missing: string[] } {
  const accountNo = collectionAccountNo?.trim() || process.env.ACCOUNT_NO?.trim() || '';
  const companyName = process.env.COMPANY_NAME?.trim() || '';
  const callbackUrl = process.env.CALLBACK_URL?.trim() || '';
  const paymentUrl = process.env.PAYMENT_URL?.trim() || process.env.NIB_PAYMENT_URL?.trim() || '';
  const key = process.env.PAYMENT_KEY?.trim() || process.env.NIB_PAYMENT_KEY?.trim() || '';

  const missing = [
    !accountNo && 'ACCOUNT_NO',
    !companyName && 'COMPANY_NAME',
    !callbackUrl && 'CALLBACK_URL',
    !paymentUrl && 'PAYMENT_URL',
    !key && 'PAYMENT_KEY',
  ].filter((v): v is string => Boolean(v));

  return {
    config: missing.length ? null : { accountNo, companyName, callbackUrl, paymentUrl, key },
    missing,
  };
}

/**
 * Unset means strict: a callback whose signature does not verify is refused.
 * `false` accepts it with a logged warning — only for confirming the signature
 * format against a live gateway, and never a resting state.
 */
export function callbackStrictMode(): boolean {
  if (process.env.PAYMENT_CALLBACK_STRICT === 'false') {
    console.warn('[payment] PAYMENT_CALLBACK_STRICT=false — unsigned callbacks will be applied.');
    return false;
  }
  return true;
}

export interface SignatureParams {
  accountNo: string;
  amount: string;
  callBackURL: string;
  companyName: string;
  key: string;
  token: string;
  transactionId: string;
  transactionTime: string;
}

/** Field order is part of the contract — do not sort or reorder. */
export function signatureBaseString(params: SignatureParams) {
  return [
    `accountNo=${params.accountNo}`,
    `amount=${params.amount}`,
    `callBackURL=${params.callBackURL}`,
    `companyName=${params.companyName}`,
    `Key=${params.key}`,
    `token=${params.token}`,
    `transactionId=${params.transactionId}`,
    `transactionTime=${params.transactionTime}`,
  ].join('&');
}

export function buildSignature(params: SignatureParams) {
  return createHash('sha256').update(signatureBaseString(params), 'utf8').digest('hex');
}

/** The super app sometimes wraps the token in its own JSON envelope. */
export function unwrapSuperAppToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    const inner = parsed?.token ?? parsed?.accessToken;
    if (typeof inner === 'string' && inner) return inner;
  } catch {
    // fall through to the pattern match
  }
  return trimmed.match(/"token"\s*:\s*"([^"]+)"/)?.[1] ?? trimmed;
}

/** Reads (without verifying) the claims of a super-app JWT. Nothing is authorised on them. */
export function readTokenClaims(token: string | null | undefined): Record<string, unknown> | null {
  const bare = unwrapSuperAppToken(token);
  const segment = bare?.split('.')[1];
  if (!segment) return null;
  try {
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

export interface CallbackSignatureResult {
  valid: boolean;
  matched: string | null;
}

/**
 * Recomputes an inbound callback's signature. The callback does not echo back
 * exactly what we signed — `transactionId` may be the bank's reference while
 * ours arrives as `txnRef`, `transactionTime` may be cut to a date, the token
 * may be JSON-wrapped — so each plausible arrangement is tried. Every candidate
 * is keyed on PAYMENT_KEY, so this widens the search, not the trust.
 */
export function verifyCallbackSignature(
  body: Record<string, unknown>,
  config: GatewayConfig,
  context: { transactionId?: string | null; transactionTime?: string | null } = {}
): CallbackSignatureResult {
  const received = body.Signature ?? body.signature ?? null;
  if (!received) return { valid: false, matched: null };

  const rawToken = body.token === undefined || body.token === null ? '' : String(body.token);
  const bareToken = unwrapSuperAppToken(rawToken) ?? rawToken;
  const claims = readTokenClaims(rawToken);

  const pick = (...values: unknown[]) => {
    const out: string[] = [];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const text = String(value);
      if (text && !out.includes(text)) out.push(text);
    }
    return out.length ? out : [''];
  };

  const receivedText = String(received).toLowerCase();

  for (const transactionId of pick(context.transactionId, claims?.transactionId, body.transactionId, body.txnRef)) {
    for (const transactionTime of pick(context.transactionTime, claims?.transactionTime, body.transactionTime)) {
      for (const token of pick(bareToken, rawToken)) {
        // The amount is never taken from the token claims: the signature is what
        // attests the sum that moved.
        for (const amount of pick(body.paidAmount, body.amount)) {
          const digest = buildSignature({
            accountNo: String(body.accountNo ?? config.accountNo),
            amount,
            callBackURL: config.callbackUrl,
            companyName: config.companyName,
            key: config.key,
            token,
            transactionId,
            transactionTime,
          });
          if (secretsMatch(digest.toLowerCase(), receivedText)) {
            return {
              valid: true,
              matched: `transactionId=${transactionId === String(body.transactionId ?? '') ? 'body' : 'ours'} amount=${amount}`,
            };
          }
        }
      }
    }
  }
  return { valid: false, matched: null };
}

/** Asks the gateway to charge a borrower's wallet. Returns the token the webview needs. */
export async function initiateWalletPayment(input: {
  config: GatewayConfig;
  transactionId: string;
  transactionTime: string;
  amount: string;
  superAppToken: string;
}): Promise<{ paymentToken: string }> {
  const { config } = input;
  const signature = buildSignature({
    accountNo: config.accountNo,
    amount: input.amount,
    callBackURL: config.callbackUrl,
    companyName: config.companyName,
    key: config.key,
    token: input.superAppToken,
    transactionId: input.transactionId,
    transactionTime: input.transactionTime,
  });

  let response: Response;
  try {
    response = await fetch(config.paymentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.superAppToken}` },
      body: JSON.stringify({
        accountNo: config.accountNo,
        amount: input.amount,
        callBackURL: config.callbackUrl,
        companyName: config.companyName,
        token: input.superAppToken,
        transactionId: input.transactionId,
        transactionTime: input.transactionTime,
        signature,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error('[payment] gateway unreachable', error);
    throw new PaymentError(502, 'Could not reach the payment service. Please try again.');
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    console.error('[payment] gateway refused initiation', response.status, body);
    const message = typeof body?.message === 'string' && response.status < 500 ? body.message : null;
    throw new PaymentError(response.status >= 500 ? 502 : 400, message || 'The payment could not be started.');
  }

  const data = body?.data as Record<string, unknown> | undefined;
  const paymentToken = body?.token ?? body?.paymentToken ?? data?.token;
  if (typeof paymentToken !== 'string' || !paymentToken) {
    throw new PaymentError(502, 'The payment service did not return a payment token.');
  }
  return { paymentToken };
}

/** Resolves a super-app bearer token to the phone number it belongs to. */
export async function validateSuperAppToken(authHeader: string): Promise<{ phone: string }> {
  const url = process.env.TOKEN_VALIDATION_API_URL?.trim();
  if (!url) throw new PaymentError(503, 'Sign-in through the super app is not configured.');
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 16) {
    throw new PaymentError(400, 'Super app token is missing or malformed.');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error('[token] validation service unreachable', error);
    throw new PaymentError(502, 'Could not verify your session. Please try again.');
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    console.warn('[token] validation refused', response.status);
    throw new PaymentError(401, 'Your super app session could not be verified. Please reopen the app.');
  }
  const phone = body?.phone;
  if (typeof phone !== 'string' && typeof phone !== 'number') {
    throw new PaymentError(401, 'Your super app session could not be verified. Please reopen the app.');
  }
  return { phone: String(phone) };
}
