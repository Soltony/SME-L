import prisma from './prisma';
import { SMS_LANGUAGES } from './notification-templates';

/**
 * Central configuration registry. The Settings page renders itself from these
 * definitions and the rest of the code reads values through `getSettings`.
 * Secrets never live here — they stay in the environment.
 */

export type SettingType = 'number' | 'string' | 'boolean' | 'select';

export const SETTING_CATEGORIES = ['platform', 'lending', 'payments', 'notifications', 'security'] as const;
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  platform: 'Platform',
  lending: 'Lending & disbursement',
  payments: 'Repayments',
  notifications: 'Notifications',
  security: 'Security & governance',
};

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  category: SettingCategory;
  type: SettingType;
  default: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Shown beside the input so the label does not have to carry the unit. */
  unit?: string;
  /** Changing it goes through maker-checker when that is switched on. */
  sensitive?: boolean;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'platform.name',
    label: 'Platform name',
    description: 'Shown in the borrower app, the console and SMS messages.',
    category: 'platform',
    type: 'string',
    default: 'SME Lending',
  },
  {
    key: 'platform.currency',
    label: 'Currency code',
    description: 'The currency every amount is denominated in. Changing it does not convert anything.',
    category: 'platform',
    type: 'string',
    default: 'ETB',
    sensitive: true,
  },
  {
    key: 'platform.supportPhone',
    label: 'Support phone',
    description: 'Contact number shown to borrowers.',
    category: 'platform',
    type: 'string',
    default: '',
  },
  {
    key: 'lending.applicationsEnabled',
    label: 'Accept new applications',
    description: 'When off, borrowers can still view and repay loans but cannot apply for new ones.',
    category: 'lending',
    type: 'boolean',
    default: true,
    sensitive: true,
  },
  {
    key: 'lending.linkPhoneByVerifiedAccount',
    label: 'Recognise a borrower who changed phone number',
    description:
      'When a number we do not know signs in, ask core banking which accounts it holds and match it to the borrower who already holds one of them, so their existing loan stays visible and payable. Only ever matches a single borrower on a bank-confirmed account, and writes every link to the audit log. Turn off to link phone numbers only through an approved phone change.',
    category: 'lending',
    type: 'boolean',
    default: true,
    sensitive: true,
  },
  {
    key: 'lending.refuseAfterWriteOff',
    label: 'Refuse borrowers with a written-off loan',
    description:
      'A write-off is a default. When on, a borrower with any written-off loan cannot borrow again from any provider. The overdue (NPL) flag alone clears once the loan leaves the active book, so this is what keeps a defaulter out.',
    category: 'lending',
    type: 'boolean',
    default: true,
    sensitive: true,
  },
  {
    key: 'lending.disbursementsEnabled',
    label: 'Send disbursements to core banking',
    description:
      'The kill switch. When off, approved loans wait in the queue and nothing is sent to core banking until it is switched back on.',
    category: 'lending',
    type: 'boolean',
    default: true,
    sensitive: true,
  },
  {
    key: 'lending.maxOpenLoansPerBorrower',
    label: 'Maximum open loans per borrower',
    description: 'Across all providers and products, including loans awaiting disbursement.',
    category: 'lending',
    type: 'number',
    default: 3,
    min: 1,
    max: 20,
    unit: 'loans',
    sensitive: true,
  },
  {
    key: 'payments.pendingTimeoutMinutes',
    label: 'Unconfirmed payment timeout',
    description: 'A wallet payment not confirmed by the gateway within this time is marked expired.',
    category: 'payments',
    type: 'number',
    default: 30,
    min: 5,
    max: 1440,
    unit: 'minutes',
  },
  {
    key: 'notifications.enabled',
    label: 'Borrower SMS',
    description:
      'Master switch for every borrower message: application updates, disbursement confirmations, repayment receipts and due-date reminders. While off, messages are logged as skipped. Wording and per-message switches are under Notifications.',
    category: 'notifications',
    type: 'boolean',
    default: true,
  },
  {
    key: 'notifications.language',
    label: 'SMS language',
    description: 'Messages with Amharic text go out in Amharic; any message without it is sent in English.',
    category: 'notifications',
    type: 'select',
    default: 'en',
    options: [...SMS_LANGUAGES],
  },
  {
    key: 'notifications.reminderDaysBefore',
    label: 'Reminder before due date',
    description: 'Borrowers are reminded this many days before an installment falls due. 0 turns reminders off.',
    category: 'notifications',
    type: 'number',
    default: 2,
    min: 0,
    max: 30,
    unit: 'days',
  },
  {
    key: 'notifications.reminderHour',
    label: 'Earliest reminder hour',
    description:
      'Reminders go out on the first maintenance run after this hour, in business time, so they never arrive overnight. 9 means from 09:00.',
    category: 'notifications',
    type: 'number',
    default: 9,
    min: 0,
    max: 23,
    unit: '24-hour clock',
  },
  {
    key: 'security.maxFailedLogins',
    label: 'Failed sign-ins before lockout',
    description: 'Consecutive wrong passwords that lock a staff account.',
    category: 'security',
    type: 'number',
    default: 5,
    min: 3,
    max: 20,
    unit: 'attempts',
    sensitive: true,
  },
  {
    key: 'security.lockoutMinutes',
    label: 'Lockout duration',
    description: 'How long a locked staff account stays locked.',
    category: 'security',
    type: 'number',
    default: 15,
    min: 1,
    max: 1440,
    unit: 'minutes',
    sensitive: true,
  },
  {
    key: 'security.requireApprovalForSettings',
    label: 'Maker-checker for sensitive settings',
    description: 'Sensitive settings changes wait for a second person with approve rights.',
    category: 'security',
    type: 'boolean',
    default: true,
    sensitive: true,
  },
];

export const SETTINGS_BY_KEY = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

export type SettingsMap = Record<string, string | number | boolean>;

export function defaultSettings(): SettingsMap {
  return Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, d.default]));
}

function decode(definition: SettingDefinition, raw: string): string | number | boolean {
  switch (definition.type) {
    case 'boolean':
      return raw === 'true';
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : definition.default;
    }
    default:
      return raw;
  }
}

let cache: { at: number; value: SettingsMap } | null = null;
const CACHE_MS = 5_000;

export function invalidateSettingsCache() {
  cache = null;
}

export async function getSettings(force = false): Promise<SettingsMap> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await prisma.systemSetting.findMany();
  const value = defaultSettings();
  for (const row of rows) {
    const definition = SETTINGS_BY_KEY.get(row.key);
    if (definition) value[row.key] = decode(definition, row.value);
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function getSetting<T extends string | number | boolean>(key: string): Promise<T> {
  const settings = await getSettings();
  return settings[key] as T;
}

export function validateSettingValue(
  key: string,
  value: unknown
): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  const definition = SETTINGS_BY_KEY.get(key);
  if (!definition) return { ok: false, error: `Unknown setting ${key}.` };

  if (definition.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
    return { ok: false, error: `${definition.label} must be on or off.` };
  }
  if (definition.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: `${definition.label} must be a whole number.` };
    }
    if (definition.min !== undefined && n < definition.min) {
      return { ok: false, error: `${definition.label} must be at least ${definition.min}.` };
    }
    if (definition.max !== undefined && n > definition.max) {
      return { ok: false, error: `${definition.label} must be at most ${definition.max}.` };
    }
    return { ok: true, value: n };
  }
  const text = String(value ?? '').trim();
  if (text.length > 200) return { ok: false, error: `${definition.label} is too long.` };
  if (definition.type === 'select' && !definition.options?.some((o) => o.value === text)) {
    return { ok: false, error: `${definition.label} has an invalid value.` };
  }
  if (key === 'platform.currency' && !/^[A-Z]{3}$/.test(text)) {
    return { ok: false, error: 'Currency must be a three-letter ISO code such as ETB.' };
  }
  return { ok: true, value: text };
}

export async function setSetting(key: string, value: string | number | boolean, userId: string) {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: String(value), updatedById: userId },
    update: { value: String(value), updatedById: userId },
  });
  invalidateSettingsCache();
}
