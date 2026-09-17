import prisma from './prisma';
import { getSettings } from './settings';
import { sendSms } from './sms';
import { maskAccount } from './format';
import { renderTemplate, TEMPLATES_BY_CODE, type TemplateName } from './notification-templates';

export type { TemplateName };

/**
 * Borrower SMS. The wording comes from Notifications → Templates, falling back
 * to the defaults in `notification-templates.ts`. Every message is logged
 * (with account numbers masked) and a failure never interrupts the operation
 * that triggered it — a loan that has been disbursed stays disbursed whether or
 * not the confirmation SMS arrives.
 */

export type NotifyOutcome = 'SENT' | 'FAILED' | 'SKIPPED';

/** Variables that must never be written to the log in full. */
const MASKED_VARS: Record<string, (value: string) => string> = {
  account: maskAccount,
};

/** False only when an operator has switched the message off. */
export async function isTemplateActive(code: TemplateName): Promise<boolean> {
  const saved = await prisma.notificationTemplate.findUnique({ where: { code }, select: { active: true } });
  return saved?.active ?? true;
}

/** The provider whose book a message belongs to, when the caller did not say. */
async function providerFor(entity?: string, entityId?: string): Promise<string | null> {
  if (!entityId) return null;
  if (entity === 'Loan') {
    const loan = await prisma.loan.findUnique({ where: { id: entityId }, select: { providerId: true } });
    return loan?.providerId ?? null;
  }
  if (entity === 'LoanApplication') {
    const application = await prisma.loanApplication.findUnique({ where: { id: entityId }, select: { providerId: true } });
    return application?.providerId ?? null;
  }
  return null;
}

/** Sends one message and logs it. Never throws; null means the attempt itself broke. */
export async function notifyBorrower(input: {
  phone: string;
  template: TemplateName;
  vars: Record<string, string>;
  entity?: string;
  entityId?: string;
  providerId?: string;
}): Promise<NotifyOutcome | null> {
  try {
    const definition = TEMPLATES_BY_CODE.get(input.template);
    if (!definition) throw new Error(`Unknown template ${input.template}`);

    const [settings, saved, providerId] = await Promise.all([
      getSettings(),
      prisma.notificationTemplate.findUnique({ where: { code: input.template } }),
      input.providerId ?? providerFor(input.entity, input.entityId),
    ]);

    // An edited row owns both languages: clearing its Amharic text means
    // "send English", not "go back to the default Amharic".
    const bodyEn = saved?.bodyEn ?? definition.bodyEn;
    const bodyAm = saved ? saved.bodyAm : definition.bodyAm;
    const source = settings['notifications.language'] === 'am' && bodyAm?.trim() ? bodyAm : bodyEn;

    const vars = { platform: String(settings['platform.name'] || 'SME Lending'), ...input.vars };
    const body = renderTemplate(source, vars);
    const logged = renderTemplate(
      source,
      Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, MASKED_VARS[k] ? MASKED_VARS[k](v) : v]))
    );

    const skipped = !settings['notifications.enabled']
      ? 'Borrower SMS is switched off in Settings.'
      : saved && !saved.active
        ? 'This message is switched off under Notifications → Templates.'
        : null;

    const result = skipped ? null : await sendSms(input.phone, body);
    const status: NotifyOutcome = skipped ? 'SKIPPED' : result?.ok ? 'SENT' : 'FAILED';

    await prisma.notificationLog.create({
      data: {
        recipient: input.phone,
        template: input.template,
        body: logged.slice(0, 2000),
        status,
        error: skipped ?? (result?.ok ? null : (result?.error ?? 'Unknown error').slice(0, 1000)),
        entity: input.entity,
        entityId: input.entityId,
        providerId,
      },
    });
    return status;
  } catch (error) {
    console.error('[notify] failed', input.template, error);
    return null;
  }
}
