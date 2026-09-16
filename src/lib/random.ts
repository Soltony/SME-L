/**
 * Cryptographically secure randomness.
 *
 * `Math.random()` is a non-cryptographic PRNG: its internal state can be
 * reconstructed from a handful of observed outputs, after which every past and
 * future value is known. Anything that gates access — a temporary password, a
 * session identifier, a correlation id that ends up in an audit trail — is
 * therefore drawn from here instead.
 *
 * Built on Web Crypto (`globalThis.crypto`) rather than `node:crypto` so the
 * same helpers work unchanged in the Node runtime, the Edge runtime and tests.
 */

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    // Every runtime this app targets — Node 18+, Edge, browsers — exposes it.
    // Falling back to Math.random() here would defeat the whole module, so a
    // missing implementation is a hard failure.
    throw new Error('No cryptographically secure random source is available.');
  }
  return c;
}

/** A v4 UUID from the platform CSPRNG. */
export function secureUuid(): string {
  const c = webCrypto();
  if (typeof c.randomUUID === 'function') return c.randomUUID();

  // randomUUID is absent on a few older Edge builds; assemble one by hand from
  // the same entropy source rather than reaching for a weaker one.
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `length` random bytes as lowercase hex. */
export function secureHex(length: number): string {
  const bytes = new Uint8Array(Math.max(1, length));
  webCrypto().getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A uniformly distributed integer in `[0, max)`.
 *
 * Drawn by rejection sampling rather than `% max`: taking the remainder of a
 * 32-bit draw biases the low values whenever `max` is not a power of two, which
 * for a password alphabet means some characters appear measurably more often
 * than others and the search space shrinks accordingly.
 */
export function secureInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError('secureInt(max) requires a positive integer.');
  }
  if (max === 1) return 0;

  const c = webCrypto();
  const buffer = new Uint32Array(1);
  // Largest multiple of `max` that fits in a uint32; draws above it are discarded.
  const limit = Math.floor(0x1_0000_0000 / max) * max;

  for (;;) {
    c.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}

/** A uniformly chosen element. Throws on an empty input rather than returning undefined. */
export function securePick<T>(items: ArrayLike<T>): T {
  if (items.length === 0) throw new RangeError('securePick requires a non-empty collection.');
  return items[secureInt(items.length)];
}

/** In-place Fisher-Yates using the CSPRNG. */
export function secureShuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = secureInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
