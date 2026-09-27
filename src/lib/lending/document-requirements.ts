import { dayToIso, isoToDay, type Day } from '@/lib/business-date';

/**
 * Where a borrower stands on one required document, worked out from every
 * version they have sent.
 *
 * Free of database imports, so the borrower screens, the review console and the
 * tests all read a document the same way.
 *
 * The rule that matters: a replacement never takes the approved version's place
 * until it is approved itself. A borrower renewing a licence keeps borrowing on
 * the old one meanwhile, and a rejected replacement leaves the old one standing.
 */

export type RequirementStatus = 'MISSING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** What the borrower is shown for each standing. */
export const REQUIREMENT_LABELS: Record<RequirementStatus, string> = {
  MISSING: 'Needed',
  PENDING: 'Waiting for review',
  APPROVED: 'Approved',
  REJECTED: 'Not accepted',
  EXPIRED: 'Expired',
};

export interface DocumentVersionLike {
  version: number;
  status: string;
  /** Business day the document expires on; it is still valid that day. */
  expiresDay: Day | null;
}

export interface RequirementState<V> {
  status: RequirementStatus;
  /** The approved version in effect, even when it has expired. */
  approved: V | null;
  /** A version waiting for review: the first upload, or a replacement. */
  pending: V | null;
  /** The newest rejected version, when it is newer than the approved one and nothing is waiting. */
  rejected: V | null;
  /** Counts towards applying: approved and not past its expiry date. */
  satisfied: boolean;
}

function newest<V extends DocumentVersionLike>(versions: V[], status: string): V | null {
  let best: V | null = null;
  for (const v of versions) if (v.status === status && (!best || v.version > best.version)) best = v;
  return best;
}

export function requirementState<V extends DocumentVersionLike>(versions: V[], todayDay: Day): RequirementState<V> {
  const approved = newest(versions, 'APPROVED');
  const pending = newest(versions, 'PENDING');
  const lastRejected = newest(versions, 'REJECTED');
  const rejected = !pending && lastRejected && (!approved || lastRejected.version > approved.version) ? lastRejected : null;
  const expired = Boolean(approved && approved.expiresDay !== null && approved.expiresDay < todayDay);
  const satisfied = Boolean(approved) && !expired;
  const status: RequirementStatus = satisfied ? 'APPROVED' : pending ? 'PENDING' : expired ? 'EXPIRED' : rejected ? 'REJECTED' : 'MISSING';
  return { status, approved, pending, rejected, satisfied };
}

/**
 * One required document as the borrower sees it: what is asked, where they
 * stand, and what they sent — never who reviewed it or the file's fingerprint.
 */
export interface BorrowerDocumentItem {
  typeId: string;
  name: string;
  description: string;
  kind: 'FILE' | 'IMAGE' | 'PDF' | 'TEXT';
  requiresExpiry: boolean;
  /** The lender asking for it; null for the bank's own documents. */
  providerName: string | null;
  status: RequirementStatus;
  satisfied: boolean;
  approved: { fileName: string | null; value: string | null; expiresOn: string | null } | null;
  pending: { fileName: string | null; value: string | null; expiresOn: string | null; submittedAt: string } | null;
  rejected: { reason: string | null } | null;
}

/** Far enough ahead for any licence or ID; anything later is a typo. */
export const MAX_EXPIRY_YEARS = 50;

/**
 * An expiry date as typed, checked. A document that has already expired is
 * refused rather than accepted and then counted as missing.
 */
export function parseExpiry(
  raw: unknown,
  todayDay: Day,
  required: boolean
): { ok: true; day: Day | null } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return required ? { ok: false, error: 'Enter the date this document expires.' } : { ok: true, day: null };
  let day: Day;
  try {
    day = isoToDay(text);
  } catch {
    return { ok: false, error: 'Enter the expiry date as YYYY-MM-DD.' };
  }
  if (day < todayDay) return { ok: false, error: 'This document has already expired. Provide one that is still valid.' };
  if (day > todayDay + MAX_EXPIRY_YEARS * 366) return { ok: false, error: 'Check the expiry date — it is too far in the future.' };
  return { ok: true, day };
}

/** A product's own documents, as stored on it. Unreadable or malformed values ask for nothing extra. */
export function parseDocumentTypeIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  } catch {
    return [];
  }
}

/** One approved document a loan was granted on. */
export interface DocumentSnapshotEntry {
  documentId: string;
  documentTypeId: string;
  name: string;
  scope: string;
  version: number;
  fileName: string | null;
  sha256: string | null;
  value: string | null;
  expiresOn: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export function parseDocumentSnapshot(raw: string | null | undefined): DocumentSnapshotEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((e) => e && typeof e.documentId === 'string') as DocumentSnapshotEntry[]) : [];
  } catch {
    return [];
  }
}

/** A stored `@db.Date` expiry as an ISO date, for display and JSON. */
export function expiryIso(day: Day | null): string | null {
  return day === null ? null : dayToIso(day);
}
