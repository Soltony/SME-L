import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import prisma from './prisma';
import { getBorrowerSession, getCurrentUser, type BorrowerSessionPayload } from './session';
import { hasPermission } from './permissions';
import { clientAddress } from './request-context';
import { secureHex } from './random';
import { NO_STORE } from './security-headers';
import { findMarkupField } from './plain-text';
import type { PermissionAction, SessionUser } from './types';
import { ApiError } from './errors';

export { ApiError };

function withPrivacyHeaders(res: NextResponse) {
  res.headers.set('Cache-Control', NO_STORE);
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('Expires', '0');
  return res;
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return withPrivacyHeaders(NextResponse.json({ error: message, ...extra }, { status }));
}

export function jsonOk<T>(data: T, status = 200) {
  return withPrivacyHeaders(NextResponse.json(data as unknown, { status }));
}

/** Who sent this, as far as it can be trusted. See `clientAddress`. */
export function clientMeta(req: NextRequest) {
  return {
    ipAddress: clientAddress(req.headers),
    userAgent: req.headers.get('user-agent'),
  };
}


/**
 * Guards an admin API route. The proxy already gates the module, but routes
 * re-check the specific action because the proxy cannot tell a create from a
 * delete.
 */
export async function requirePermission(
  moduleKey: string,
  action: PermissionAction
): Promise<{ user: SessionUser } | { response: NextResponse }> {
  const user = await getCurrentUser({ allowRefresh: false });
  if (!user) return { response: jsonError('Not authenticated', 401) };
  if (user.passwordChangeRequired) {
    return { response: jsonError('Password change required', 403) };
  }
  if (!hasPermission(user, moduleKey, action)) {
    return { response: jsonError(`You do not have permission to ${action} ${moduleKey}.`, 403) };
  }
  return { user };
}

export function isGuardFailure(
  result: { user: SessionUser } | { response: NextResponse }
): result is { response: NextResponse } {
  return 'response' in result;
}

/**
 * The provider a staff member is confined to, as a Prisma `where` fragment.
 * An unscoped account (platform staff) gets an empty object.
 */
export function providerWhere(user: Pick<SessionUser, 'providerId'>): { providerId?: string } {
  return user.providerId ? { providerId: user.providerId } : {};
}

/** Refuses access to another provider's record, with the same answer as "not found". */
export function assertProviderAccess(
  user: Pick<SessionUser, 'providerId'>,
  providerId: string | null | undefined,
  what = 'Record'
) {
  if (user.providerId && providerId !== user.providerId) {
    throw new ApiError(404, `${what} not found.`);
  }
}

/**
 * Wraps a handler so unexpected throws become clean JSON — and, in production,
 * never a description of our internals. `ApiError` is authored for the caller
 * and passes through; a Zod failure names the field; anything else becomes a
 * generic sentence with a reference that matches the server log.
 */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const result = await fn();
    if (result instanceof NextResponse) return withPrivacyHeaders(result);
    return withPrivacyHeaders(NextResponse.json(result as unknown));
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return jsonError(error.message, error.status, error.field ? { field: error.field } : undefined);
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return jsonError(issue?.message || 'Invalid request.', 400, {
        field: issue?.path?.join('.') || undefined,
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const reference = secureHex(8);
    console.error(`[api] unhandled error ref=${reference}`, error);

    if (process.env.NODE_ENV !== 'production') {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
      return jsonError(message, 500, { reference });
    }
    return jsonError('An unexpected error occurred. Quote the reference below if you report this.', 500, {
      reference,
    });
  }
}

export function parsePaging(req: NextRequest | URL, defaultSize = 25) {
  const url = req instanceof URL ? req : new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const rawSize = Number(url.searchParams.get('pageSize') ?? defaultSize) || defaultSize;
  const pageSize = Math.min(200, Math.max(1, rawSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Reads a JSON body, or the response that refuses it: an oversized body, a
 * body that is not JSON, or one carrying HTML/script tags in a text field.
 * Callers narrow with `instanceof NextResponse` and return it as-is.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: NextRequest,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<T | NextResponse> {
  const tooLarge = () => jsonError('Request body is too large.', 413);

  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  const text = await req.text().catch(() => '');
  if (text.length > maxBytes) return tooLarge();
  if (!text) return {} as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError('Request body is not valid JSON.', 400);
  }
  if (!parsed || typeof parsed !== 'object') {
    return jsonError('Request body must be a JSON object.', 400);
  }

  const markupField = findMarkupField(parsed);
  if (markupField) {
    return jsonError('HTML and script tags are not allowed here.', 400, { field: markupField });
  }

  return parsed as T;
}

/** A ready-to-return 429 with the standard `Retry-After` header. */
export function tooManyRequests(retryAfterSeconds: number, message?: string) {
  const res = jsonError(message ?? 'Too many requests. Please wait a moment and try again.', 429);
  res.headers.set('Retry-After', String(Math.max(1, retryAfterSeconds)));
  return res;
}

export interface BorrowerContext {
  session: BorrowerSessionPayload;
  borrower: { id: string; phoneNumber: string; fullName: string | null; status: string; isNpl: boolean };
}

/**
 * Guards a borrower API route. The borrower is always taken from the signed
 * session — never from a request field — so no endpoint can be pointed at
 * somebody else's loans.
 */
export async function requireBorrower(): Promise<BorrowerContext | { response: NextResponse }> {
  const session = await getBorrowerSession();
  if (!session) return { response: jsonError('Your session has expired. Please reopen the app.', 401) };

  const borrower = await prisma.borrower.findUnique({
    where: { id: session.borrowerId },
    select: { id: true, phoneNumber: true, fullName: true, status: true, isNpl: true },
  });
  if (!borrower || borrower.phoneNumber !== session.phone) {
    return { response: jsonError('Your session has expired. Please reopen the app.', 401) };
  }
  if (borrower.status === 'BLOCKED') {
    return { response: jsonError('This account is blocked. Please contact support.', 403) };
  }
  return { session, borrower };
}

export function isBorrowerFailure(
  result: BorrowerContext | { response: NextResponse }
): result is { response: NextResponse } {
  return 'response' in result;
}
