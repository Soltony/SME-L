import prisma from './prisma';
import { getSettings } from './settings';
import { sendSms } from './sms';
import { maskAccount } from './format';

/**
 * Borrower SMS. Every message is logged (with account numbers masked) and a
 * failure never interrupts the operation that triggered it — a loan that has
 * been disbursed stays disbursed whether or not the confirmation SMS arrives.
 */

const TEMPLATES = {
  LOAN_DISBURSED:
    '{{platform}}: {{amount}} has been sent to your account {{account}}. Loan {{loanNumber}}; first payment due {{dueDate}}.',
  DISBURSEMENT_FAILED:
    '{{platform}}: we could not send loan {{loanNumber}} to account {{account}}. Nothing is owed on it. Please try again later.',
  APPLICATION_RECEIVED:
    '{{platform}}: we received your application {{applicationNo}} for {{amount}}. We will let you know once it is reviewed.',
  APPLICATION_REJECTED:
    '{{platform}}: your application {{applicationNo}} was not approved.{{reason}}',
  REPAYMENT_RECEIVED:
    '{{platform}}: received {{amount}} for loan {{loanNumber}} (receipt {{receiptNo}}). Remaining balance {{balance}}.',
  LOAN_PAID_OFF: '{{platform}}: loan {{loanNumber}} is fully repaid. Thank you!',
  DUE_REMINDER: '{{platform}}: {{amount}} is due on {{dueDate}} for loan {{loanNumber}}. Please repay on time to avoid penalties.',
} as const;

export type TemplateName = keyof typeof TEMPLATES;

/** Variables that must never be written to the log in full. */
const MASKED_VARS: Record<string, (value: string) => string> = {
  account: maskAccount,
};

function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}

export async function notifyBorrower(input: {
  phone: string;
  template: TemplateName;
  vars: Record<string, string>;
  entity?: string;
  entityId?: string;
}): Promise<void> {
  try {
    const settings = await getSettings();
    const vars = { platform: String(settings['platform.name'] || 'SME Lending'), ...input.vars };
    const body = render(TEMPLATES[input.template], vars);
    const logged = render(
      TEMPLATES[input.template],
      Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, MASKED_VARS[k] ? MASKED_VARS[k](v) : v]))
    );

    if (!settings['notifications.enabled']) {
      await prisma.notificationLog.create({
        data: {
          recipient: input.phone,
          template: input.template,
          body: logged.slice(0, 2000),
          status: 'SKIPPED',
          error: 'Borrower SMS is switched off in settings.',
          entity: input.entity,
          entityId: input.entityId,
        },
      });
      return;
    }

    const result = await sendSms(input.phone, body);
    await prisma.notificationLog.create({
      data: {
        recipient: input.phone,
        template: input.template,
        body: logged.slice(0, 2000),
        status: result.ok ? 'SENT' : 'FAILED',
        error: result.ok ? null : (result.error ?? 'Unknown error').slice(0, 1000),
        entity: input.entity,
        entityId: input.entityId,
      },
    });
  } catch (error) {
    console.error('[notify] failed', input.template, error);
  }
}
