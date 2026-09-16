import { SignJWT, compactVerify, jwtVerify } from 'jose';
import { requireSecret } from './secrets';
import { secureUuid } from './random';

// Kept free of `next/headers` and Prisma imports so token work stays usable
// from any runtime without dragging Node-only code along.

export const ACCESS_TOKEN_EXP = '15m';
export const ACCESS_TOKEN_MINUTES = 15;
export const REFRESH_TOKEN_DAYS = 7;

/**
 * The signing key, resolved at first use and never defaulted.
 *
 * Falling back to an empty string here would sign every staff and borrower token
 * with an empty HMAC key — a key anybody can guess, because it is the absence
 * of one. The application would look perfectly healthy while any party could
 * mint a valid Super Admin session. So resolution fails closed: an unset value,
 * the placeholder from `.env.example`, or anything under 32 characters throws
 * rather than degrading.
 *
 * Resolved lazily and cached: at module scope this would run before the
 * environment is loaded in some runtimes, and would surface as an unrelated
 * import error rather than as the configuration fault it is.
 */
let cachedKey: Uint8Array | null = null;

function signingKey(): Uint8Array {
  if (!cachedKey) {
    cachedKey = new TextEncoder().encode(requireSecret('SESSION_SECRET', { minLength: 32 }));
  }
  return cachedKey;
}

/** Drops the cached key so a test can sign against a different secret. */
export function resetSigningKey() {
  cachedKey = null;
}

export async function encryptJwt(payload: Record<string, unknown>, expiresIn: string) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signingKey());
}

export async function decryptJwt<T = any>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), { algorithms: ['HS256'] });
    return payload as T;
  } catch {
    return null;
  }
}

/**
 * What a token turned out to be.
 *
 * `expired` is deliberately separate from `invalid`, because they mean opposite
 * things. An expired token is one we genuinely issued and whose signature still
 * checks out — it has simply aged past its window, which is a normal event a
 * session recovers from. An invalid one never came from us: a wrong signature,
 * a payload edited in the browser, a forged algorithm, a truncated string.
 * Collapsing the two lets an edited token be treated as merely old.
 */
export type TokenCheck<T> =
  | { status: 'valid'; payload: T }
  | { status: 'expired'; payload: T }
  | { status: 'invalid' };

/**
 * Verifies a token's signature first, and only then reads its claims.
 *
 * `jwtVerify` cannot answer this on its own: it refuses an expired token and a
 * forged one with the same `null`, leaving the caller unable to tell a session
 * that needs renewing from one that is being attacked. So the signature is
 * checked on its own with `compactVerify` — which validates the MAC and the
 * declared algorithm, and nothing else — and expiry is evaluated afterwards
 * against a payload already known to be authentic.
 *
 * Pinning `algorithms` is what stops a token that declares `alg: none`, or a
 * public-key algorithm, from being accepted as HMAC-signed.
 */
export async function verifyJwt<T = any>(token: string): Promise<TokenCheck<T>> {
  let claims: Record<string, unknown>;

  try {
    const { payload } = await compactVerify(token, signingKey(), { algorithms: ['HS256'] });
    claims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { status: 'invalid' };
  }

  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    return { status: 'invalid' };
  }

  // Every token this application mints carries an expiry. One without it is not
  // ours, whatever its signature says, and is refused rather than treated as
  // eternal.
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { status: 'invalid' };

  if (Date.now() >= exp * 1000) return { status: 'expired', payload: claims as T };
  return { status: 'valid', payload: claims as T };
}

/** A session identifier. Always from the CSPRNG — see `lib/random.ts`. */
export function uuid() {
  return secureUuid();
}

export function expiryFromDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export function expiryFromMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000);
}
