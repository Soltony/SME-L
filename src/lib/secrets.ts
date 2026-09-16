/**
 * Secret resolution and comparison.
 *
 * Every secret this app relies on is resolved through here so that three
 * failure modes are impossible rather than merely unlikely:
 *
 *   1. an unset variable silently degrading to an empty key,
 *   2. the placeholder from `.env.example` reaching a deployment,
 *   3. a comparison that returns early and leaks how much of a guess was right.
 *
 * Resolution is lazy and cached: reading at module scope would evaluate before
 * the environment is loaded in some runtimes, and would also make the failure
 * surface as an import error far from its cause.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Values shipped in `.env.example`. A deployment carrying one of these is unconfigured. */
const PLACEHOLDERS = new Set(
  [
    'change-me',
    'change-me-to-a-long-random-string',
    'changeme',
    'secret',
    'password',
    'merchant-signing-key',
    'your-secret-here',
    'todo',
    'placeholder',
  ].map((value) => value.toLowerCase())
);

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigurationError';
  }
}

export function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase());
}

export interface SecretOptions {
  /** Reject anything shorter. Signing keys default to 32. */
  minLength?: number;
}

const cache = new Map<string, string>();

/**
 * Reads a required secret, or throws. Fails closed by design: an application
 * that cannot sign a session must refuse to start the request, not issue a
 * token anybody can forge.
 */
export function requireSecret(name: string, options: SecretOptions = {}): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const minLength = options.minLength ?? 32;
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw.trim() === '') {
    throw new SecretConfigurationError(
      `${name} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
    );
  }

  const value = raw.trim();

  if (isPlaceholderSecret(value)) {
    throw new SecretConfigurationError(
      `${name} still holds the placeholder value shipped in .env.example. Generate a real secret before deploying.`
    );
  }

  if (value.length < minLength) {
    throw new SecretConfigurationError(
      `${name} must be at least ${minLength} characters; it is ${value.length}.`
    );
  }

  cache.set(name, value);
  return value;
}

/** Same rules, but absence is allowed — returns null instead of throwing. */
export function optionalSecret(name: string, options: SecretOptions = {}): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  return requireSecret(name, options);
}

/** Clears the resolution cache. Tests only — the environment does not change at runtime. */
export function resetSecretCache() {
  cache.clear();
}

/**
 * Constant-time equality for secrets and signatures.
 *
 * Both operands are hashed to a fixed 32 bytes first, so the comparison itself
 * cannot leak the length either — `timingSafeEqual` throws on a length mismatch,
 * and returning early on that would be the very leak this exists to close.
 * Empty or missing values never match, including against each other.
 */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = createHash('sha256').update(String(a), 'utf8').digest();
  const right = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(left, right);
}
