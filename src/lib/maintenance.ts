import prisma from './prisma';
import { createAuditLog } from './audit-log';
import { businessHour, dateFromDay, dayFromDate, dayToIso, formatDay, today } from './business-date';
import { formatMoney, toCents } from './money';
import { getSettings } from './settings';
import { isTemplateActive, notifyBorrower } from './notifications';
import { runAccrualBatch } from './lending/loan-service';
import { processDisbursementQueue } from './lending/disbursement';
import { expireStalePaymentIntents } from './lending/payments';

/**
 * One maintenance pass. Every step is idempotent, so a missed run is caught
 * up by the next one and two drivers running at once do no harm:
 *
 *  - wallet payments nobody confirmed are marked expired;
 *  - queued disbursements are sent, and interrupted ones flagged for review;
 *  - every active loan is accrued to today (a no-op after the first run of the day);
 *  - due-date reminders go out once per business day, from the configured hour.
 *
 * Driven by `/api/cron/tick` or `npm run run:worker`. The previous SME worker
 * ran each job on its own 24-hour sleep, so a restart at the wrong moment
 * silently skipped a day of accruals.
 */

let running = false;

export interface MaintenanceSummary {
  businessDate: string;
  expiredPayments: number;
  disbursements: Awaited<ReturnType<typeof processDisbursementQueue>> | null;
  accrual: { processed: number; posted: number; failed: number; nplFlagged: number } | null;
  reminders: number | null;
  skipped?: string;
}

async function claimDailyJob(name: string, day: number): Promise<boolean> {
  const key = `job.${name}.lastDay`;
  const value = dayToIso(day);
  const updated = await prisma.systemSetting.updateMany({ where: { key, NOT: { value } }, data: { value } });
  if (updated.count === 1) return true;
  const existing = await prisma.systemSetting.findUnique({ where: { key } });
  if (existing) return false;
  try {
    await prisma.systemSetting.create({ data: { key, value } });
    return true;
  } catch {
    return false; // another instance created it first
  }
}

async function sendDueReminders(day: number): Promise<number> {
  const settings = await getSettings();
  const daysBefore = Number(settings['notifications.reminderDaysBefore']) || 0;
  if (daysBefore <= 0 || !settings['notifications.enabled']) return 0;
  // Switched off under Notifications: skip the batch rather than log thousands of skips.
  if (!(await isTemplateActive('DUE_REMINDER'))) return 0;

  const target = day + daysBefore;
  const due = await prisma.loanInstallment.findMany({
    where: { dueDate: dateFromDay(target), loan: { status: 'ACTIVE' } },
    include: {
      loan: { select: { id: true, loanNumber: true, providerId: true, borrower: { select: { phoneNumber: true } } } },
    },
    take: 5000,
  });

  const currency = String(settings['platform.currency'] || 'ETB');
  let sent = 0;
  for (const installment of due) {
    const remaining = toCents(installment.principalDue) - toCents(installment.principalPaid);
    if (remaining <= 0) continue;
    const outcome = await notifyBorrower({
      phone: installment.loan.borrower.phoneNumber,
      template: 'DUE_REMINDER',
      vars: {
        amount: formatMoney(remaining, currency),
        dueDate: formatDay(dayFromDate(installment.dueDate)),
        loanNumber: installment.loan.loanNumber,
      },
      entity: 'Loan',
      entityId: installment.loan.id,
      providerId: installment.loan.providerId,
    });
    if (outcome === 'SENT') sent += 1;
  }
  return sent;
}

export async function runMaintenance(): Promise<MaintenanceSummary> {
  const day = today();
  const summary: MaintenanceSummary = {
    businessDate: dayToIso(day),
    expiredPayments: 0,
    disbursements: null,
    accrual: null,
    reminders: null,
  };
  if (running) return { ...summary, skipped: 'A maintenance pass is already running in this process.' };
  running = true;

  try {
    summary.expiredPayments = await expireStalePaymentIntents();
    summary.disbursements = await processDisbursementQueue();

    const accrual = await runAccrualBatch({ toDay: day });
    summary.accrual = {
      processed: accrual.processed,
      posted: accrual.posted,
      failed: accrual.failed,
      nplFlagged: accrual.nplFlagged,
    };
    if (accrual.failed > 0) {
      console.error('[maintenance] accrual failures', accrual.errors.slice(0, 20));
    }

    // The day's claim is taken only once the send hour has come, so a pass just
    // after midnight cannot spend it and text borrowers in the night.
    const reminderHour = Number((await getSettings())['notifications.reminderHour']) || 0;
    if (businessHour() >= reminderHour && (await claimDailyJob('reminders', day))) {
      summary.reminders = await sendDueReminders(day);
    }

    const changed =
      summary.expiredPayments > 0 ||
      (summary.disbursements?.attempted ?? 0) > 0 ||
      (summary.disbursements?.markedUnknown ?? 0) > 0 ||
      (summary.accrual?.processed ?? 0) > 0 ||
      (summary.reminders ?? 0) > 0;
    if (changed) {
      await createAuditLog({
        actorId: 'SYSTEM',
        actorType: 'SYSTEM',
        action: 'MAINTENANCE_RUN',
        details: { ...summary, accrualErrors: accrual.errors.slice(0, 20) },
      });
    }
    return summary;
  } finally {
    running = false;
  }
}
