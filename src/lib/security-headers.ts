/**
 * The response headers every route gets.
 *
 * Kept free of Node-only imports so `next.config.ts` can use the same values
 * the proxy applies per request.
 */

/**
 * Browser features this app never uses.
 *
 * Exhaustive rather than illustrative: `Permissions-Policy` denies only what it
 * names, so every capability left off the list stays available to any script
 * that manages to run — which is the situation the policy exists for.
 */
const DENIED_FEATURES = [
  'accelerometer',
  'ambient-light-sensor',
  'autoplay',
  'battery',
  'bluetooth',
  'camera',
  'display-capture',
  'document-domain',
  'encrypted-media',
  'execution-while-not-rendered',
  'execution-while-out-of-viewport',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'speaker-selection',
  'storage-access',
  'usb',
  'web-share',
  'xr-spatial-tracking',
];

export const PERMISSIONS_POLICY = DENIED_FEATURES.map((feature) => `${feature}=()`).join(', ');

export const HSTS = 'max-age=63072000; includeSubDomains; preload';

/**
 * Where the app may be framed.
 *
 * `'none'` unless an operator deliberately embeds it: a clickjacked frame over
 * the console can approve a write-off or a disbursement with one misdirected
 * click, so the default has to be refusal rather than a wildcard.
 */
export function frameAncestors(): string {
  const configured = (process.env.FRAME_ANCESTORS || '').trim();
  if (!configured) return "'none'";
  return configured;
}

/** The legacy header that matches the frame policy, or null when it cannot express it. */
export function frameOptionsHeader(): string | null {
  const ancestors = frameAncestors();
  if (ancestors === "'none'") return 'DENY';
  if (ancestors === "'self'") return 'SAMEORIGIN';
  return null;
}

export interface CspOptions {
  nonce: string;
  /** Development builds of React use eval(); the production build never does. */
  allowEval: boolean;
}

export function buildCsp({ nonce, allowEval }: CspOptions): string {
  const devEval = allowEval ? " 'unsafe-eval'" : '';

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    // 'unsafe-inline' is still required by the Tailwind/Radix layer, which
    // writes inline style attributes the server cannot nonce. The exposure is
    // style injection, not script execution.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    `frame-ancestors ${frameAncestors()}`,
    "frame-src 'none'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Applies the full header set to a response. */
export function applySecurityHeaders(headers: Headers, csp: string, nonce: string): Headers {
  headers.set('Content-Security-Policy', csp);
  headers.set('x-nonce', nonce);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  headers.set('Strict-Transport-Security', HSTS);

  const frameOptions = frameOptionsHeader();
  if (frameOptions) headers.set('X-Frame-Options', frameOptions);

  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');

  headers.delete('X-Powered-By');
  headers.delete('X-AspNet-Version');
  headers.delete('X-AspNetMvc-Version');

  return headers;
}

/**
 * Every page in this app is personal — a borrower's limit, a loan balance, the
 * console — so nothing but the build output may be stored by a shared cache or
 * the back/forward store.
 */
export function isPrivatePath(path: string): boolean {
  return !path.startsWith('/_next/');
}

export const NO_STORE = 'no-store, no-cache, must-revalidate, private';
