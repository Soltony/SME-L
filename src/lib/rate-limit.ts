/**
 * Fixed-window rate limiting.
 *
 * Per-account lockout already stops one account being ground down, but it does
 * nothing about the two attacks that do not target a single account: spraying
 * one common password across many accounts, and replaying an unauthenticated
 * endpoint that has no account to lock. A window keyed on the caller closes
 * both.
 *
 * The counters live in process memory. On a single instance that is exact; run
 * more than one and each holds its own window, so the effective ceiling is the
 * configured limit times the instance count. The upgrade path is a shared store
 * (Redis) — but a limit that is loose by a known factor is still the difference
 * between thousands of attempts a minute and a handful.
 */

export interface RateLimitRule {
  /** Attempts permitted inside one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets — the value for `Retry-After`. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounds memory if a flood arrives with a high-cardinality key. */
const MAX_TRACKED_KEYS = 20_000;

function sweep(now: number) {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/** Named rules, so a limit is described in one place rather than at each call site. */
export const RATE_LIMITS = {
  /** Staff sign-in. Tight: a legitimate operator needs a handful of tries at most. */
  adminLogin: { limit: 8, windowMs: 5 * 60_000 },
  /** Password change — authenticated, but a guessing oracle for the current password. */
  passwordChange: { limit: 10, windowMs: 15 * 60_000 },
  /** Super-app token exchange. Generous: a flaky webview retries on its own. */
  sessionExchange: { limit: 500, windowMs: 5 * 60_000 },
  /** The test-login bypass, which mints a session without any credential. */
  testLogin: { limit: 10, windowMs: 10 * 60_000 },
  /** Eligibility checks read scoring data; a borrower needs very few. */
  eligibility: { limit: 30, windowMs: 60_000 },
  /** Loan applications. A borrower never legitimately needs more than a few. */
  loanApplication: { limit: 5, windowMs: 10 * 60_000 },
  /** Document uploads for an application. */
  documentUpload: { limit: 30, windowMs: 10 * 60_000 },
  /** Starting a wallet repayment. */
  paymentInitiation: { limit: 10, windowMs: 5 * 60_000 },
  /** Gateway callbacks. High, because a gateway legitimately retries. */
  paymentCallback: { limit: 120, windowMs: 60_000 },
  /** Account lookups against core banking. */
  accountLookup: { limit: 20, windowMs: 5 * 60_000 },
  /** Maintenance tick — one scheduler, so anything more is someone probing. */
  cronTick: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * Records one attempt and reports whether it is allowed.
 *
 * `identity` should be the account when there is one and the caller's address
 * otherwise: keying an authenticated limit on the address would let one shared
 * NAT exhaust everybody's budget, and keying an unauthenticated one on a
 * claimed identity would let the caller reset it at will.
 */
export function consumeRateLimit(
  name: RateLimitName,
  identity: string,
  rule: RateLimitRule = RATE_LIMITS[name]
): RateLimitResult {
  const now = Date.now();
  const key = `${name}:${identity}`;

  if (windows.size > MAX_TRACKED_KEYS) sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > rule.limit) {
    return { ok: false, remaining: 0, retryAfterSeconds };
  }
  return { ok: true, remaining: rule.limit - existing.count, retryAfterSeconds };
}

/** Drops a window — called after a successful sign-in so a genuine user is never left throttled. */
export function clearRateLimit(name: RateLimitName, identity: string) {
  windows.delete(`${name}:${identity}`);
}

/** Tests only. */
export function resetAllRateLimits() {
  windows.clear();
}
