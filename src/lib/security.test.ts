import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SecretConfigurationError,
  isPlaceholderSecret,
  optionalSecret,
  requireSecret,
  resetSecretCache,
  secretsMatch,
} from './secrets';
import { secureHex, secureInt, securePick, secureShuffle, secureUuid } from './random';
import { RATE_LIMITS, clearRateLimit, consumeRateLimit, resetAllRateLimits } from './rate-limit';
import {
  addressKey,
  additionalTrustedOrigins,
  checkRequestOrigin,
  clientAddress,
  normalizeOrigin,
  trustsProxyHeaders,
} from './request-context';
import {
  PERMISSIONS_POLICY,
  buildCsp,
  frameAncestors,
  frameOptionsHeader,
  isPrivatePath,
} from './security-headers';
import { PASSWORD_MIN_LENGTH, generateTempPassword, validatePassword } from './admin-users';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetSecretCache();
  resetAllRateLimits();
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('requireSecret', () => {
  beforeEach(() => resetSecretCache());

  it('refuses an unset value rather than defaulting to an empty key', () => {
    delete process.env.TEST_SECRET;
    expect(() => requireSecret('TEST_SECRET')).toThrow(SecretConfigurationError);
  });

  it('refuses a blank value', () => {
    process.env.TEST_SECRET = '   ';
    expect(() => requireSecret('TEST_SECRET')).toThrow(SecretConfigurationError);
  });

  it('refuses the placeholder shipped in .env.example', () => {
    process.env.TEST_SECRET = 'change-me-to-a-long-random-string';
    expect(() => requireSecret('TEST_SECRET')).toThrow(/placeholder/i);
  });

  it('refuses a value shorter than the minimum', () => {
    process.env.TEST_SECRET = 'short';
    expect(() => requireSecret('TEST_SECRET', { minLength: 32 })).toThrow(/at least 32/);
  });

  it('accepts and trims a real secret', () => {
    process.env.TEST_SECRET = `  ${'k'.repeat(48)}  `;
    expect(requireSecret('TEST_SECRET')).toBe('k'.repeat(48));
  });

  it('treats a placeholder as such regardless of case or padding', () => {
    expect(isPlaceholderSecret('  CHANGE-ME  ')).toBe(true);
    expect(isPlaceholderSecret('Placeholder')).toBe(true);
    expect(isPlaceholderSecret('OK82vJLU7XlttuLOWb6XOrR6zO1WQ3Bf')).toBe(false);
  });

  it('optionalSecret returns null when unset but still validates when present', () => {
    delete process.env.TEST_SECRET;
    expect(optionalSecret('TEST_SECRET')).toBeNull();

    process.env.TEST_SECRET = 'change-me';
    expect(() => optionalSecret('TEST_SECRET', { minLength: 8 })).toThrow(/placeholder/i);
  });
});

describe('secretsMatch', () => {
  it('matches identical values', () => {
    expect(secretsMatch('a'.repeat(40), 'a'.repeat(40))).toBe(true);
  });

  it('rejects differing values, including ones sharing a long prefix', () => {
    expect(secretsMatch('abcdefghijklmnop', 'abcdefghijklmnoq')).toBe(false);
  });

  it('rejects on a length difference without throwing', () => {
    expect(secretsMatch('abc', 'abcdef')).toBe(false);
  });

  it('never matches an empty or missing operand', () => {
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(null, null)).toBe(false);
    expect(secretsMatch(undefined, 'abc')).toBe(false);
    expect(secretsMatch('abc', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

describe('secure randomness', () => {
  it('produces a well-formed v4 UUID', () => {
    expect(secureUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('does not repeat itself across many draws', () => {
    const seen = new Set(Array.from({ length: 500 }, () => secureUuid()));
    expect(seen.size).toBe(500);
  });

  it('secureHex returns the requested byte count as hex', () => {
    expect(secureHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('secureInt stays inside the half-open range', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = secureInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('secureInt covers every value of a small range', () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 3000; i += 1) {
      const value = secureInt(5);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect(counts.size).toBe(5);
    // Rejection sampling means no modulo bias; every bucket should be near 600.
    for (const count of counts.values()) expect(count).toBeGreaterThan(400);
  });

  it('secureInt rejects a non-positive bound', () => {
    expect(() => secureInt(0)).toThrow(RangeError);
    expect(() => secureInt(-1)).toThrow(RangeError);
    expect(() => secureInt(2.5)).toThrow(RangeError);
  });

  it('securePick refuses an empty collection instead of returning undefined', () => {
    expect(() => securePick([])).toThrow(RangeError);
    expect(securePick(['x'])).toBe('x');
  });

  it('secureShuffle preserves every element', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = secureShuffle([...input]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('consumeRateLimit', () => {
  it('allows exactly the configured number of attempts', () => {
    const rule = { limit: 3, windowMs: 60_000 };
    expect(consumeRateLimit('adminLogin', 'a', rule).ok).toBe(true);
    expect(consumeRateLimit('adminLogin', 'a', rule).ok).toBe(true);
    expect(consumeRateLimit('adminLogin', 'a', rule).ok).toBe(true);
    expect(consumeRateLimit('adminLogin', 'a', rule).ok).toBe(false);
  });

  it('reports a retry delay once the window is exhausted', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    consumeRateLimit('adminLogin', 'b', rule);
    const blocked = consumeRateLimit('adminLogin', 'b', rule);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps identities separate, so one account cannot exhaust another budget', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    expect(consumeRateLimit('adminLogin', 'user-a', rule).ok).toBe(true);
    expect(consumeRateLimit('adminLogin', 'user-b', rule).ok).toBe(true);
    expect(consumeRateLimit('adminLogin', 'user-a', rule).ok).toBe(false);
  });

  it('keeps named limits separate from each other', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    expect(consumeRateLimit('adminLogin', 'shared', rule).ok).toBe(true);
    expect(consumeRateLimit('loanApplication', 'shared', rule).ok).toBe(true);
  });

  it('expires the window once its time has passed', () => {
    const rule = { limit: 1, windowMs: 1 };
    consumeRateLimit('adminLogin', 'c', rule);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(consumeRateLimit('adminLogin', 'c', rule).ok).toBe(true);
        resolve();
      }, 10);
    });
  });

  it('clearRateLimit frees the identity, so a genuine sign-in is not left throttled', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    consumeRateLimit('adminLogin', 'd', rule);
    expect(consumeRateLimit('adminLogin', 'd', rule).ok).toBe(false);
    clearRateLimit('adminLogin', 'd');
    expect(consumeRateLimit('adminLogin', 'd', rule).ok).toBe(true);
  });

  it('every named rule is a positive limit over a positive window', () => {
    for (const [name, rule] of Object.entries(RATE_LIMITS)) {
      expect(rule.limit, name).toBeGreaterThan(0);
      expect(rule.windowMs, name).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

describe('clientAddress', () => {
  it('ignores forwarded headers when no trusted proxy is declared', () => {
    delete process.env.TRUST_PROXY;
    const headers = new Headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' });
    expect(trustsProxyHeaders()).toBe(false);
    expect(clientAddress(headers)).toBeNull();
    // Falls back to one shared bucket — a global ceiling, never "no limit".
    expect(addressKey(headers)).toBe('shared:untrusted-proxy');
  });

  it('honours the left-most forwarded entry when a proxy is declared', () => {
    process.env.TRUST_PROXY = 'true';
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(clientAddress(headers)).toBe('203.0.113.7');
    expect(addressKey(headers)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip behind a trusted proxy', () => {
    process.env.TRUST_PROXY = 'true';
    expect(clientAddress(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
  });
});

describe('normalizeOrigin', () => {
  it('reduces a URL to its origin', () => {
    expect(normalizeOrigin('https://example.et/some/path?q=1')).toBe('https://example.et');
  });

  it('rejects a non-http scheme and unparseable input', () => {
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
  });
});

describe('additionalTrustedOrigins', () => {
  it('parses a comma-separated list and drops anything malformed', () => {
    process.env.ALLOWED_ORIGIN = 'https://a.et, https://b.et/path ,,not-a-url';
    expect(additionalTrustedOrigins()).toEqual(['https://a.et', 'https://b.et']);
  });
});

describe('checkRequestOrigin', () => {
  const url = new URL('https://guesslow.et/api/admin/users');

  it('accepts a request declaring the same origin', () => {
    const headers = new Headers({ origin: 'https://guesslow.et' });
    expect(checkRequestOrigin(headers, url)).toBe('same-origin');
  });

  it('rejects a request declaring another origin', () => {
    const headers = new Headers({ origin: 'https://evil.example' });
    expect(checkRequestOrigin(headers, url)).toBe('cross-origin');
  });

  it('rejects a look-alike origin rather than prefix-matching it', () => {
    const headers = new Headers({ origin: 'https://guesslow.et.evil.example' });
    expect(checkRequestOrigin(headers, url)).toBe('cross-origin');
  });

  it('falls back to Referer when Origin is absent', () => {
    const headers = new Headers({ referer: 'https://guesslow.et/admin/users' });
    expect(checkRequestOrigin(headers, url)).toBe('same-origin');
  });

  it('reports neither header as missing rather than as a pass', () => {
    expect(checkRequestOrigin(new Headers(), url)).toBe('missing');
  });

  it('accepts an explicitly configured additional origin', () => {
    const headers = new Headers({ origin: 'https://superapp.et' });
    expect(checkRequestOrigin(headers, url, ['https://superapp.et'])).toBe('same-origin');
  });

  it('accepts the forwarded host only when a proxy is declared', () => {
    const internal = new URL('http://10.0.0.5:3005/api/admin/users');
    const headers = new Headers({
      origin: 'https://guesslow.et',
      'x-forwarded-host': 'guesslow.et',
      'x-forwarded-proto': 'https',
    });

    delete process.env.TRUST_PROXY;
    expect(checkRequestOrigin(headers, internal)).toBe('cross-origin');

    process.env.TRUST_PROXY = 'true';
    expect(checkRequestOrigin(headers, internal)).toBe('same-origin');
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe('security headers', () => {
  it('defaults to refusing all framing', () => {
    delete process.env.FRAME_ANCESTORS;
    expect(frameAncestors()).toBe("'none'");
    expect(frameOptionsHeader()).toBe('DENY');
    expect(buildCsp({ nonce: 'n', allowEval: false })).toContain("frame-ancestors 'none'");
  });

  it('never emits a wildcard frame-ancestors by default', () => {
    delete process.env.FRAME_ANCESTORS;
    expect(buildCsp({ nonce: 'n', allowEval: false })).not.toContain('frame-ancestors *');
  });

  it('maps a configured same-origin policy onto the legacy header', () => {
    process.env.FRAME_ANCESTORS = "'self'";
    expect(frameOptionsHeader()).toBe('SAMEORIGIN');
  });

  it('drops the legacy header when the policy is an allow-list it cannot express', () => {
    process.env.FRAME_ANCESTORS = 'https://partner.example';
    expect(frameOptionsHeader()).toBeNull();
  });

  it('pins scripts to a nonce and forbids eval in production builds', () => {
    const csp = buildCsp({ nonce: 'abc123', allowEval: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('allows images from this origin only, so no external host can be used to beacon data out', () => {
    const csp = buildCsp({ nonce: 'n', allowEval: false });
    expect(csp).toContain("img-src 'self' data: blob:;");
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
  });

  it('denies every browser feature it names, and names many', () => {
    expect(PERMISSIONS_POLICY).toContain('camera=()');
    expect(PERMISSIONS_POLICY).toContain('geolocation=()');
    expect(PERMISSIONS_POLICY).toContain('payment=()');
    expect(PERMISSIONS_POLICY).toContain('usb=()');
    expect(PERMISSIONS_POLICY.split(',').length).toBeGreaterThan(20);
  });

  it('treats every page as uncacheable — each shows personal financial data — except build output', () => {
    expect(isPrivatePath('/api/app/loans')).toBe(true);
    expect(isPrivatePath('/admin/users')).toBe(true);
    expect(isPrivatePath('/loans/abc')).toBe(true);
    expect(isPrivatePath('/connect')).toBe(true);
    expect(isPrivatePath('/_next/static/chunk.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

describe('validatePassword', () => {
  const ok = (password: string) => validatePassword(password).ok;

  it('accepts a strong password', () => {
    expect(ok('Jm7#kVpQz!2rXw')).toBe(true);
  });

  it('enforces the minimum length', () => {
    expect(ok('Ab3!xY9z')).toBe(false);
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
  });

  it('requires all four character classes', () => {
    expect(ok('jm7#kvpqz!2rxw')).toBe(false); // no uppercase
    expect(ok('JM7#KVPQZ!2RXW')).toBe(false); // no lowercase
    expect(ok('Jmx#kVpQz!rXwT')).toBe(false); // no digit
    expect(ok('Jm7kVpQz42rXwT')).toBe(false); // no symbol
  });

  it('rejects common passwords that satisfy every complexity rule', () => {
    expect(ok('Password1!')).toBe(false);
    expect(ok('Password123!')).toBe(false);
    expect(ok('Admin@1234')).toBe(false);
    expect(ok('Welcome@2026')).toBe(false);
    expect(ok('ChangeMe!2026')).toBe(false);
  });

  it('rejects a run of the same character', () => {
    expect(ok('Zq#aaaa9RvTm')).toBe(false);
  });

  it('rejects keyboard and alphabet sequences', () => {
    expect(ok('Qwerty!12wXzP')).toBe(false);
    expect(ok('Xk#9mabcdRvT')).toBe(false);
    expect(ok('Xk#9m1234RvT')).toBe(false);
  });

  it('rejects an over-long password', () => {
    expect(ok(`Aa1!${'q'.repeat(200)}`)).toBe(false);
  });
});

describe('generateTempPassword', () => {
  it('always satisfies the policy the account will be held to', () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateTempPassword();
      const verdict = validatePassword(password);
      expect(verdict.ok, `${password}: ${verdict.ok ? '' : verdict.error}`).toBe(true);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()));
    expect(seen.size).toBe(200);
  });

  it('does not place the guaranteed classes in a fixed order', () => {
    // A naive generator emits upper, lower, digit, symbol at positions 0-3.
    const firstChars = new Set(Array.from({ length: 100 }, () => generateTempPassword()[0]));
    expect(firstChars.size).toBeGreaterThan(4);
  });
});
