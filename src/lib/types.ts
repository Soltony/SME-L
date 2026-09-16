// Shared domain types. SQL Server has no Prisma enums, so these unions are the
// single source of truth for what the String status columns may contain.

export const LOAN_STATUSES = [
  'PENDING_DISBURSEMENT',
  'ACTIVE',
  'PAID_OFF',
  'WRITTEN_OFF',
  'DISBURSEMENT_FAILED',
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** Loans that still carry principal on the books or are about to. */
export const OPEN_LOAN_STATUSES: LoanStatus[] = ['PENDING_DISBURSEMENT', 'ACTIVE'];

export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'DISBURSED',
  'FAILED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const DISBURSEMENT_STATUSES = ['PENDING', 'SENT', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export const PAYMENT_INTENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

export const REPAYMENT_CHANNELS = ['SUPERAPP', 'MANUAL', 'TEST'] as const;
export type RepaymentChannel = (typeof REPAYMENT_CHANNELS)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const JOURNAL_TYPES = [
  'CAPITAL',
  'DISBURSEMENT',
  'ACCRUAL',
  'REPAYMENT',
  'REVERSAL',
  'WRITE_OFF',
  'REFUND',
  'TAX_REMITTANCE',
  'ADJUSTMENT',
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const PENDING_CHANGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED'] as const;
export type PendingChangeStatus = (typeof PENDING_CHANGE_STATUSES)[number];

// --------------------------------------
// PERMISSIONS
// --------------------------------------

export const PERMISSION_ACTIONS = ['read', 'create', 'update', 'delete', 'approve'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type ModulePermission = Partial<Record<PermissionAction, boolean>>;
export type Permissions = Record<string, ModulePermission>;

export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  status: string;
  role: string;
  roleId: string;
  permissions: Permissions;
  passwordChangeRequired: boolean;
  /** Set for staff who belong to one provider; they never see another's data. */
  providerId: string | null;
}
