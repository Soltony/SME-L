import type { NextConfig } from 'next';
import { HSTS, PERMISSIONS_POLICY, frameOptionsHeader } from './src/lib/security-headers';

/**
 * The single origin allowed to make credentialed cross-origin calls, validated
 * at build time: a wildcard or a scheme-less value alongside
 * `Access-Control-Allow-Credentials: true` fails the build instead of shipping.
 * (The previous SME build sent `nibteraloan.nibbank.com.et` with no scheme,
 * which browsers ignore.)
 */
function resolveAllowedOrigin(): string {
  const configured = (process.env.ALLOWED_ORIGIN || '').trim();
  if (!configured) return 'http://localhost:3006';
  const first = configured.split(',')[0].trim();
  if (first === '*' || first === 'null') {
    throw new Error('ALLOWED_ORIGIN cannot be a wildcard while credentials are allowed.');
  }
  let parsed: URL;
  try {
    parsed = new URL(first);
  } catch {
    throw new Error(`ALLOWED_ORIGIN must be an absolute origin; received "${first}".`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error(`ALLOWED_ORIGIN must use https (or be localhost); received "${first}".`);
  }
  return parsed.origin;
}

const baseSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  { key: 'Strict-Transport-Security', value: HSTS },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
];

const frameOptions = frameOptionsHeader();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Type errors fail the build. The previous SME build ignored 129 of them.
  typescript: { ignoreBuildErrors: false },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [...baseSecurityHeaders, ...(frameOptions ? [{ key: 'X-Frame-Options', value: frameOptions }] : [])],
      },
      {
        source: '/api/:path*',
        headers: [
          ...baseSecurityHeaders,
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: resolveAllowedOrigin() },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT' },
          { key: 'Access-Control-Allow-Headers', value: 'Accept, Content-Type, Authorization, X-Requested-With' },
          { key: 'Vary', value: 'Origin' },
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
        ],
      },
    ];
  },
};

export default nextConfig;
