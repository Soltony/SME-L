/**
 * Development switches.
 *
 * Each one removes a control that exists because real money moves: the test
 * sign-in skips super-app authentication, and simulated core banking pays out
 * loans without a bank. GuessLow allowed its bypass in any environment and
 * relied on a banner to warn about it; a lending platform cannot afford that,
 * so every switch here is hard-off when NODE_ENV is production, whatever the
 * environment variable says.
 */

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** `/connect` offers a phone-number sign-in with no super-app token. */
export function isTestLoginEnabled(): boolean {
  return !isProduction() && process.env.ALLOW_TEST_LOGIN === 'true';
}

/** Disbursements succeed and account lookups return sample accounts without calling core banking. */
export function isCbsSimulated(): boolean {
  return !isProduction() && process.env.CBS_SIMULATE === 'true';
}

/** Warnings for the admin dashboard, so nobody mistakes a test deployment for a live one. */
export function activeDevSwitches(): string[] {
  const out: string[] = [];
  if (isTestLoginEnabled()) out.push('Test sign-in is enabled (ALLOW_TEST_LOGIN).');
  if (isCbsSimulated()) out.push('Core banking is simulated (CBS_SIMULATE) — no real money moves.');
  if (!isProduction() && process.env.BUSINESS_DATE_OVERRIDE) {
    out.push(`The business date is pinned to ${process.env.BUSINESS_DATE_OVERRIDE} (BUSINESS_DATE_OVERRIDE).`);
  }
  // Allowed in production (it exists to confirm a live gateway's signature
  // format), so it is the one switch that must be loud everywhere.
  if (process.env.PAYMENT_CALLBACK_STRICT === 'false') {
    out.push('Unsigned payment callbacks are accepted (PAYMENT_CALLBACK_STRICT=false). Turn this off once the gateway signature is confirmed.');
  }
  return out;
}
