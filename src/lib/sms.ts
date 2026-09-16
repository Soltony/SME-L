/**
 * The SMS transport: one adapter around the provider endpoint configured in the
 * environment, with no templates, no database and no logging of its own.
 *
 * `notifications.ts` layers templating and the delivery log on top of this for
 * ordinary borrower messaging. Anything whose body must not be written down —
 * one-time passwords above all — calls `sendSms` directly instead.
 *
 * The recipient reaches this module in the stored 251XXXXXXXXX form and leaves it
 * as 0XXXXXXXXX: the gateway addresses subscribers the local way, and this is the
 * last point at which the number is still ours to reshape.
 *
 * The provider is a form-post endpoint reading two fields, `to` and `text`. It
 * does not parse a JSON body - one arrives as an empty $_POST and every field
 * reads back undefined - and it has no notion of a sender id or a subject.
 */
import { toLocalPhone } from './format';

const LOG = '[sms]';

/**
 * The gateway answers 200 even when it has failed, so the status line alone
 * cannot be believed: a message the script never sent would otherwise be
 * written to the delivery log as SENT. A rendered PHP diagnostic in the body is
 * the one unambiguous sign of that, and it is read as the failure it is.
 */
const PHP_DIAGNOSTIC = /<b>\s*(Warning|Fatal error|Parse error)\s*<\/b>|Fatal error:/i;

export interface SmsResult {
  ok: boolean;
  error?: string;
}

/** SMS_URL is the name the previous SME deployment used; both are accepted. */
function smsUrl(): string | undefined {
  return process.env.SMS_API_URL || process.env.SMS_URL || undefined;
}

export function isSmsConfigured(): boolean {
  return Boolean(smsUrl());
}

/**
 * Posts one message to the provider. Unlike the notification pipeline this
 * reports a missing provider as a failure rather than quietly succeeding: a
 * caller that is delivering a credential has to know the message did not go
 * out, so it can fall back to something a human can act on.
 */
export async function sendSms(
  recipient: string,
  body: string,
  subject?: string | null
): Promise<SmsResult> {
  const url = smsUrl();
  const to = toLocalPhone(recipient);

  // An SMS has no subject line and the gateway has no field for one, so a
  // subject an operator has set on a template opens the message instead of
  // being dropped on the floor. None of the shipped templates set one.
  const trimmedSubject = subject?.trim();
  const text = trimmedSubject ? `${trimmedSubject}\n${body}` : body;

  if (!url) {
    console.error(`${LOG} not sent to ${to}: SMS_API_URL is unset`);
    return { ok: false, error: 'No SMS provider is configured (SMS_API_URL is unset).' };
  }

  const params = new URLSearchParams();
  params.append('to', to);
  params.append('text', text);

  console.log(
    `${LOG} POST ${url}`,
    JSON.stringify({
      to,
      // The text itself is deliberately absent: a one-time password travels
      // through here, and stdout is a log like any other.
      textChars: text.length,
      authHeader: Boolean(process.env.SMS_API_KEY),
    })
  );

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(process.env.SMS_API_KEY ? { Authorization: `Bearer ${process.env.SMS_API_KEY}` } : {}),
      },
      body: params.toString(),
      cache: 'no-store',
    });

    // Read the body on success as well as failure. A gateway that answers 200
    // while refusing the message is otherwise indistinguishable from one that
    // sent it, and that is exactly the case worth seeing.
    const answer = await response.text().catch(() => '');
    console.log(
      `${LOG} <- ${response.status} ${response.statusText} in ${Date.now() - startedAt}ms: ` +
        (answer.trim() ? answer.slice(0, 500) : '(empty body)')
    );

    if (!response.ok) {
      return { ok: false, error: `Provider responded ${response.status}: ${answer.slice(0, 500)}` };
    }
    if (PHP_DIAGNOSTIC.test(answer)) {
      return {
        ok: false,
        error: `Provider answered ${response.status} but reported an error: ${answer
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300)}`,
      };
    }
    return { ok: true };
  } catch (error: any) {
    console.error(`${LOG} transport error after ${Date.now() - startedAt}ms → ${url}`, error);
    return { ok: false, error: error?.message || 'Unknown transport error' };
  }
}
