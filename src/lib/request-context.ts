/**
 * What a request claims about itself, and how much of it is safe to believe.
 *
 * `X-Forwarded-For`, `Origin` and `Referer` are all set by the caller. Two of
 * them are still useful — a browser sets Origin honestly and cannot be scripted
 * into lying about it, which is exactly what makes it a CSRF control — but the
 * forwarded address is worth nothing unless a proxy we control overwrites it.
 * The rules for each live here so no route has to decide for itself.
 */

/** Kept in sync with the runtime by `TRUST_PROXY=true` in the environment. */
export function trustsProxyHeaders(): boolean {
  return process.env.TRUST_PROXY === 'true';
}

/** The origins allowed to make state-changing requests, beyond the request's own host. */
export function additionalTrustedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value));
}

/** Scheme + host + port, or null when the input is not an absolute URL. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The client address to record and to rate-limit on.
 *
 * Without a declared trusted proxy the forwarded headers are ignored entirely
 * and every caller shares one key. That is deliberate: a shared key degrades a
 * per-address limit to a global ceiling, which is restrictive but sound,
 * whereas honouring a spoofable header degrades it to no limit at all — the
 * attacker simply varies the header on every attempt. It also stops an audit
 * entry being attributed to an address the caller picked.
 */
export function clientAddress(headers: Headers): string | null {
  if (!trustsProxyHeaders()) return null;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    // The left-most entry is the original client when a trusted proxy appends.
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 45);
  }

  const real = headers.get('x-real-ip')?.trim();
  return real ? real.slice(0, 45) : null;
}

/** A stable rate-limit key for an unauthenticated caller. */
export function addressKey(headers: Headers): string {
  return clientAddress(headers) ?? 'shared:untrusted-proxy';
}

export type OriginVerdict = 'same-origin' | 'cross-origin' | 'missing';

/**
 * Compares the request's declared origin against the host it was sent to.
 *
 * `Origin` is preferred; `Referer` is the fallback for the handful of clients
 * that omit Origin on same-origin form posts. Neither present is reported as
 * `missing` rather than as a pass, so the caller decides — a browser always
 * sends one on a cross-site state-changing request, so absence means either a
 * same-origin navigation or a non-browser client.
 */
export function checkRequestOrigin(
  headers: Headers,
  requestUrl: URL,
  extraAllowed: string[] = []
): OriginVerdict {
  const declared = normalizeOrigin(headers.get('origin')) ?? normalizeOrigin(headers.get('referer'));
  if (!declared) return 'missing';

  const allowed = new Set<string>([requestUrl.origin, ...extraAllowed]);

  // A self-hosted server usually sees its own bound address in the request URL
  // (http://localhost:3006), not the public host the browser used. The Host
  // header carries that public host, and a victim's browser always sets it to
  // the site it is talking to — never to the attacker's — so matching the
  // declared origin's host against it is a sound same-origin test. Without this
  // every production POST behind a reverse proxy would be refused. (Found in
  // the SME security review; GuessLow compared against the request URL only.)
  const hostHeader = headers.get('host')?.trim().toLowerCase();
  if (hostHeader && new URL(declared).host.toLowerCase() === hostHeader) {
    return 'same-origin';
  }

  // Behind a TLS-terminating proxy the runtime sees http:// on the forwarded
  // host while the browser reports https://. Trust the forwarded host only
  // where the deployment says a proxy is in front.
  if (trustsProxyHeaders()) {
    const host = headers.get('x-forwarded-host') ?? headers.get('host');
    const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || requestUrl.protocol.replace(':', '');
    if (host) {
      allowed.add(`${proto}://${host}`);
      allowed.add(`https://${host}`);
    }
  }

  return allowed.has(declared) ? 'same-origin' : 'cross-origin';
}
