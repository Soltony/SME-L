/**
 * The borrower messages the platform sends: when each goes out, the
 * placeholders it may use and its default wording in English and Amharic.
 *
 * Free of database imports, so the template editor checks a draft with exactly
 * the rules the API applies when it is saved. Operator wording lives in
 * `NotificationTemplate`; a message nobody has edited sends the default here.
 */

export interface TemplateDefinition {
  code: string;
  name: string;
  /** When it is sent, for the operator deciding whether to switch it off. */
  trigger: string;
  /** Placeholders this message is given, besides the ones every message has. */
  placeholders: readonly string[];
  bodyEn: string;
  bodyAm: string;
}

/** Filled in for every message. */
export const COMMON_PLACEHOLDERS = ['platform'] as const;

export const TEMPLATE_DEFINITIONS = [
  {
    code: 'APPLICATION_RECEIVED',
    name: 'Application received',
    trigger: 'A borrower submits an application that needs manual review.',
    placeholders: ['applicationNo', 'amount'],
    bodyEn: '{platform}: we received your application {applicationNo} for {amount}. We will let you know once it is reviewed.',
    bodyAm: '{platform}: ማመልከቻ ቁጥር {applicationNo} ({amount}) ደርሶናል። ግምገማው ሲጠናቀቅ እናሳውቅዎታለን።',
  },
  {
    code: 'APPLICATION_REJECTED',
    name: 'Application rejected',
    trigger: 'A reviewer rejects an application. {reason} is empty when no reason was given.',
    placeholders: ['applicationNo', 'reason'],
    bodyEn: '{platform}: your application {applicationNo} was not approved. {reason}',
    bodyAm: '{platform}: ማመልከቻ ቁጥር {applicationNo} ተቀባይነት አላገኘም። {reason}',
  },
  {
    code: 'LOAN_DISBURSED',
    name: 'Loan disbursed',
    trigger: 'Core banking confirms the loan amount reached the borrower’s account.',
    placeholders: ['amount', 'account', 'loanNumber', 'dueDate'],
    bodyEn: '{platform}: {amount} has been sent to your account {account}. Loan {loanNumber}; first payment due {dueDate}.',
    bodyAm: '{platform}: {amount} ወደ ሂሳብ ቁጥር {account} ተልኳል። ብድር ቁጥር {loanNumber}፤ የመጀመሪያ ክፍያ ቀን {dueDate}።',
  },
  {
    code: 'DISBURSEMENT_FAILED',
    name: 'Disbursement failed',
    trigger: 'Core banking refuses the disbursement. The loan is cancelled and nothing is owed.',
    placeholders: ['loanNumber', 'account'],
    bodyEn: '{platform}: we could not send loan {loanNumber} to account {account}. Nothing is owed on it. Please try again later.',
    bodyAm: '{platform}: ብድር ቁጥር {loanNumber} ወደ ሂሳብ ቁጥር {account} መላክ አልተቻለም። በዚህ ብድር ምንም ዕዳ የለብዎትም። እባክዎ ቆይተው እንደገና ይሞክሩ።',
  },
  {
    code: 'DUE_REMINDER',
    name: 'Payment due reminder',
    trigger: 'Once a day, the set number of days before an installment falls due (Settings → Notifications).',
    placeholders: ['amount', 'dueDate', 'loanNumber'],
    bodyEn: '{platform}: {amount} is due on {dueDate} for loan {loanNumber}. Please repay on time to avoid penalties.',
    bodyAm: '{platform}: ለብድር ቁጥር {loanNumber} {amount} እስከ {dueDate} መከፈል አለበት። ቅጣት እንዳይጣልብዎ እባክዎ በወቅቱ ይክፈሉ።',
  },
  {
    code: 'REPAYMENT_RECEIVED',
    name: 'Repayment received',
    trigger: 'A repayment is posted and the loan still has a balance.',
    placeholders: ['amount', 'loanNumber', 'receiptNo', 'balance'],
    bodyEn: '{platform}: received {amount} for loan {loanNumber} (receipt {receiptNo}). Remaining balance {balance}.',
    bodyAm: '{platform}: ለብድር ቁጥር {loanNumber} {amount} ተቀብለናል (ደረሰኝ {receiptNo})። ቀሪ ሂሳብ {balance}።',
  },
  {
    code: 'LOAN_PAID_OFF',
    name: 'Loan paid off',
    trigger: 'A repayment clears the loan in full.',
    placeholders: ['loanNumber'],
    bodyEn: '{platform}: loan {loanNumber} is fully repaid. Thank you!',
    bodyAm: '{platform}: ብድር ቁጥር {loanNumber} ሙሉ በሙሉ ተከፍሏል። እናመሰግናለን!',
  },
] as const satisfies readonly TemplateDefinition[];

export type TemplateName = (typeof TEMPLATE_DEFINITIONS)[number]['code'];

export const TEMPLATES_BY_CODE = new Map<string, TemplateDefinition>(TEMPLATE_DEFINITIONS.map((d) => [d.code, d]));

export const SMS_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'am', label: 'Amharic' },
] as const;

/** Long enough for four SMS parts of plain text; anything longer is a letter, not a text message. */
export const MAX_TEMPLATE_LENGTH = 600;

/** Example values for previewing a draft. */
export const SAMPLE_VALUES: Record<string, string> = {
  platform: 'SME Lending',
  applicationNo: 'AP-000123',
  loanNumber: 'LN-000123',
  receiptNo: 'RC-0004567',
  amount: 'ETB 5,000.00',
  balance: 'ETB 3,250.00',
  account: '********7890',
  dueDate: '15 Oct 2026',
  reason: 'Monthly turnover is below the product minimum.',
};

const PLACEHOLDER = /\{(\w+)\}/g;

export function allowedPlaceholders(definition: TemplateDefinition): string[] {
  return [...COMMON_PLACEHOLDERS, ...definition.placeholders];
}

/**
 * Fills the placeholders. An empty value (a rejection with no reason) leaves
 * no double space or dangling blank behind.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(PLACEHOLDER, (_, name: string) => vars[name] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** What is wrong with a draft body, or null when it can be saved. */
export function checkTemplateBody(definition: TemplateDefinition, body: string, label: string): string | null {
  const text = body.trim();
  if (!text) return `${label} cannot be empty.`;
  if (text.length > MAX_TEMPLATE_LENGTH) return `${label} is longer than ${MAX_TEMPLATE_LENGTH} characters.`;

  const allowed = allowedPlaceholders(definition);
  const unknown = [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].filter((name) => !allowed.includes(name));
  if (unknown.length) {
    // A typo here would otherwise reach every borrower as a blank.
    return `${label} uses ${unknown.map((n) => `{${n}}`).join(', ')}, which this message does not have. Available: ${allowed
      .map((n) => `{${n}}`)
      .join(', ')}.`;
  }
  return null;
}

/**
 * How many SMS parts a message takes. Plain text fits 160 characters in one
 * part (153 per part once split); a single character outside that alphabet —
 * any Amharic at all — drops it to 70 (67). An estimate: the gateway, not us,
 * decides the encoding.
 */
export function smsParts(text: string): { chars: number; parts: number; unicode: boolean } {
  const unicode = /[^\n\r\x20-\x7E]/.test(text);
  const single = unicode ? 70 : 160;
  const perPart = unicode ? 67 : 153;
  const chars = [...text].length;
  return { chars, parts: chars <= single ? 1 : Math.ceil(chars / perPart), unicode };
}
