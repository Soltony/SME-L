import { sendSms, type SmsResult } from './sms';

/**
 * Delivery of the one-time passwords issued when an admin account is created or
 * reset.
 *
 * The credential goes to the account holder's own phone and nowhere else: it is
 * not returned in the API response, not rendered in the admin UI, and not
 * written to `NotificationLog` — which is why this bypasses the template
 * pipeline in `notifications.ts` and talks to the transport directly. The
 * operator who creates an account is not a party to that account's password
 * (CWE-522), and neither is anyone who can read the delivery log afterwards.
 *
 * Nor is this gated on the `notifications.enabled` setting. That switch governs
 * borrower messaging, and an operator silencing borrower SMS is not asking for
 * their colleagues' accounts to become unreachable.
 *
 * The single exception is the terminal fallback below, which exists because the
 * alternative is worse: an account nobody can sign into, and no way to hand it
 * over except a second reset that fails the same way.
 */

export type TempPasswordPurpose = 'CREATED' | 'RESET';

export interface TempPasswordDelivery {
  fullName: string;
  phoneNumber: string;
  password: string;
  purpose: TempPasswordPurpose;
}

export type SmsSender = (recipient: string, body: string) => Promise<SmsResult>;

export interface DeliveryOutcome {
  delivered: boolean;
  /** Why the send failed, with the password stripped out. Safe to surface and to audit. */
  error?: string;
}

/** The message the account holder receives. */
export function buildTempPasswordSms(input: {
  fullName: string;
  password: string;
  purpose: TempPasswordPurpose;
}): string {
  const firstName = input.fullName.trim().split(/\s+/)[0] || 'there';
  const opening =
    input.purpose === 'CREATED'
      ? `Hi ${firstName}, your SME Lending staff account is ready.`
      : `Hi ${firstName}, your SME Lending staff password has been reset.`;

  return (
    `${opening} One-time password: ${input.password} — you must change it at first sign-in. ` +
    `Never share it, including with our staff.`
  );
}

/**
 * A provider that echoes the failed request back in its error body would
 * otherwise put the password into the audit trail and the admin's screen — the
 * exact disclosure this module exists to prevent.
 */
function redactPassword(text: string | undefined, password: string): string | undefined {
  if (!text) return undefined;
  return text.split(password).join('[redacted]');
}

/**
 * Sends the one-time password to its owner. Never throws: a transport failure
 * must not roll back an account that has already been created.
 *
 * `send` is injectable so the fallback path can be tested without a provider.
 */
export async function deliverTempPassword(
  input: TempPasswordDelivery,
  send: SmsSender = sendSms
): Promise<DeliveryOutcome> {
  const body = buildTempPasswordSms(input);

  let result: SmsResult;
  try {
    result = await send(input.phoneNumber, body);
  } catch (error: any) {
    result = { ok: false, error: error?.message || 'Unknown transport error' };
  }

  if (result.ok) return { delivered: true };

  const reason = redactPassword(result.error, input.password) ?? 'unknown error';

  // Last resort. Printed where only someone with server access can read it, and
  // labelled for what it is, so whoever picks it up knows the credential has
  // now been seen by a third party and the account should be reset once SMS is
  // working again.
  console.warn(
    [
      '[temp-password] SMS delivery FAILED — falling back to the terminal.',
      `  reason:            ${reason}`,
      `  recipient:         ${input.phoneNumber} (${input.fullName})`,
      `  one-time password: ${input.password}`,
      '  Hand this over in person, then reset the account once SMS is restored.',
    ].join('\n')
  );

  return { delivered: false, error: reason };
}
