import { MODULE_KEYS } from './route-permissions';
import type { PermissionAction, Permissions } from './types';

/**
 * The roles a new installation starts with. They are ordinary roles — Access
 * Control can edit or replace any of them except Super Admin — and they are
 * shaped around segregation of duties: the people who set up products do not
 * approve them, and the people who move money do not approve their own moves.
 */

type Grant = Partial<Record<PermissionAction, boolean>>;

const R: Grant = { read: true };
const RC: Grant = { read: true, create: true };
const RCU: Grant = { read: true, create: true, update: true };
const RA: Grant = { read: true, approve: true };

function matrix(grants: Record<string, Grant>): Permissions {
  const out: Permissions = {};
  for (const key of MODULE_KEYS) {
    const g = grants[key] ?? {};
    out[key] = {
      read: Boolean(g.read),
      create: Boolean(g.create),
      update: Boolean(g.update),
      delete: Boolean(g.delete),
      approve: Boolean(g.approve),
    };
  }
  return out;
}

export interface RolePreset {
  name: string;
  description: string;
  permissions: Permissions;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    name: 'Loan Officer',
    description: 'Reviews applications, follows up borrowers and records branch repayments for approval.',
    permissions: matrix({
      dashboard: R,
      applications: { read: true, update: true, approve: true },
      loans: R,
      disbursements: R,
      repayments: RC,
      borrowers: R,
      // "Did the borrower get the SMS?" is a follow-up question; the wording is not theirs to change.
      notifications: R,
      'notifications.logs': R,
      products: R,
      reports: R,
      approvals: R,
    }),
  },
  {
    name: 'Credit Manager',
    description: 'Designs providers, products and scoring models. Changes wait for an approver.',
    permissions: matrix({
      dashboard: R,
      applications: R,
      loans: R,
      borrowers: R,
      providers: RCU,
      products: RCU,
      'credit-scoring': RCU,
      reports: R,
      approvals: R,
    }),
  },
  {
    name: 'Finance',
    description: 'Capital, tax remittance, write-offs, refunds and disbursement exceptions — requested, then approved by someone else.',
    permissions: matrix({
      dashboard: R,
      loans: { read: true, update: true },
      disbursements: { read: true, update: true },
      repayments: { read: true, create: true, update: true },
      borrowers: R,
      accounting: RC,
      reports: R,
      approvals: R,
    }),
  },
  {
    name: 'Approver',
    description: 'The checker. Approves or rejects changes requested by others; cannot request changes.',
    permissions: matrix({
      dashboard: R,
      applications: R,
      loans: RA,
      disbursements: RA,
      repayments: RA,
      borrowers: R,
      providers: RA,
      products: RA,
      'credit-scoring': RA,
      accounting: RA,
      reports: R,
      approvals: RA,
      settings: RA,
    }),
  },
  {
    name: 'Auditor',
    description: 'Read-only access to everything, including the audit trail.',
    permissions: matrix(Object.fromEntries(MODULE_KEYS.filter((k) => !['users', 'access-control'].includes(k)).map((k) => [k, R]))),
  },
];
