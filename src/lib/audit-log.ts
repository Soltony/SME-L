import prisma from './prisma';
import { uuid } from './jwt';
import type { TxClient } from './db-lock';

export interface AuditLogInput {
  actorId: string;
  actorName?: string | null;
  actorType?: 'ADMIN' | 'BORROWER' | 'SYSTEM' | 'EXTERNAL';
  action: string;
  entity?: string;
  entityId?: string;
  details?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string;
}

const REDACTED = '***REDACTED***';
const SENSITIVE_KEYS = [
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'token',
  'superapptoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'signature',
  'key',
  'secret',
  'cookie',
];

function truncate(value: string, maxLen = 8000) {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…(truncated, len=${value.length})`;
}

/** Recursively strips credentials so tokens never land in the audit table. */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitizeDetails(v, depth + 1));

  if (typeof value === 'object') {
    const anyVal = value as Record<string, unknown> & { toFixed?: unknown };
    // Prisma Decimal: keep the exact decimal string, never a float.
    if (typeof anyVal.toFixed === 'function' && typeof (anyVal as { d?: unknown }).d !== 'undefined') {
      return String(value);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(anyVal)) {
      out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? REDACTED : sanitizeDetails(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

export function newCorrelationId() {
  return uuid();
}

function toRow(input: AuditLogInput) {
  return {
    actorId: input.actorId || 'SYSTEM',
    actorName: input.actorName ?? undefined,
    actorType: input.actorType ?? 'ADMIN',
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    details:
      input.details === undefined
        ? undefined
        : truncate(JSON.stringify(sanitizeDetails(input.details))),
    ipAddress: input.ipAddress ?? undefined,
    userAgent: input.userAgent?.slice(0, 1000) ?? undefined,
    correlationId: input.correlationId,
  };
}

/** Audit writes must never break the operation being audited. */
export async function createAuditLog(input: AuditLogInput) {
  try {
    await prisma.auditLog.create({ data: toRow(input) });
  } catch (error) {
    console.error('[audit] failed to write audit log', {
      action: input.action,
      entity: input.entity,
      error,
    });
  }
}

/**
 * Writes the audit row inside a business transaction, so it commits or rolls
 * back with the change it describes. The previous system logged
 * `REPAYMENT_SUCCESS` through a separate connection from inside the repayment
 * transaction: when the transaction rolled back, the audit trail still said the
 * money had been applied.
 */
export async function createAuditLogInTx(tx: TxClient, input: AuditLogInput) {
  await tx.auditLog.create({ data: toRow(input) });
}
