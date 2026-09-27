import { unlink } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import { acquireAppLock, locks, type TxClient } from '@/lib/db-lock';
import { createAuditLogInTx } from '@/lib/audit-log';
import { dateFromDay, dayFromDate, dayToIso, formatDay, today, type Day } from '@/lib/business-date';
import {
  cleanFileName,
  DOCUMENT_KINDS,
  DocumentError,
  MAX_ANSWER_LENGTH,
  resolveDocumentPath,
  storeDocument,
  type DocumentKind,
} from '@/lib/documents';
import { hasPermission } from '@/lib/permissions';
import { isTemplateActive, notifyBorrower } from '@/lib/notifications';
import { getSettings } from '@/lib/settings';
import type { SessionUser } from '@/lib/types';
import {
  expiryIso,
  parseDocumentTypeIds,
  parseExpiry,
  REQUIREMENT_LABELS,
  requirementState,
  type BorrowerDocumentItem,
  type DocumentSnapshotEntry,
  type RequirementStatus,
} from './document-requirements';

/**
 * Borrower documents, provided once and reviewed before any application.
 *
 * Documents used to belong to an application: a borrower uploaded them after
 * applying, once per application, and only reviewed products asked at all.
 * Now they belong to the borrower. The bank's documents (GLOBAL) are asked of
 * everyone and reviewed by bank staff; a provider's documents (PRODUCT) are
 * asked for by the products that list them and reviewed by that provider's
 * staff. A borrower may apply for a product only when every document it asks
 * for is approved and in date — instant products included.
 *
 * Each upload is a new version. A replacement waits for review while the
 * approved version stays in effect, so keeping documents current never
 * interrupts a borrower's access to credit.
 */

const TYPE_SELECT = {
  id: true,
  scope: true,
  providerId: true,
  name: true,
  description: true,
  kind: true,
  requiresExpiry: true,
  status: true,
  provider: { select: { name: true } },
} satisfies Prisma.DocumentTypeSelect;

type TypeRow = Prisma.DocumentTypeGetPayload<{ select: typeof TYPE_SELECT }>;

const VERSION_SELECT = {
  id: true,
  documentTypeId: true,
  version: true,
  status: true,
  fileName: true,
  sizeBytes: true,
  sha256: true,
  value: true,
  expiresOn: true,
  submittedAt: true,
  reviewedByName: true,
  reviewedAt: true,
  reviewNote: true,
} satisfies Prisma.BorrowerDocumentSelect;

type VersionRow = Prisma.BorrowerDocumentGetPayload<{ select: typeof VERSION_SELECT }>;

/** Versions that can still count: the rest (superseded, withdrawn) are history. */
const LIVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

export interface RequiredDocumentType {
  id: string;
  scope: string;
  providerId: string | null;
  /** Null for the bank's documents. */
  providerName: string | null;
  name: string;
  description: string;
  kind: DocumentKind;
  requiresExpiry: boolean;
}

export interface DocumentVersionView {
  id: string;
  version: number;
  status: string;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  value: string | null;
  expiresOn: string | null;
  submittedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface ChecklistItem {
  type: RequiredDocumentType;
  status: RequirementStatus;
  satisfied: boolean;
  approved: DocumentVersionView | null;
  pending: DocumentVersionView | null;
  rejected: DocumentVersionView | null;
}

export function documentKind(raw: string): DocumentKind {
  return raw in DOCUMENT_KINDS ? (raw as DocumentKind) : 'FILE';
}

function toRequired(row: TypeRow): RequiredDocumentType {
  return {
    id: row.id,
    scope: row.scope,
    providerId: row.providerId,
    providerName: row.provider?.name ?? null,
    name: row.name,
    description: row.description,
    kind: documentKind(row.kind),
    requiresExpiry: row.requiresExpiry,
  };
}

function viewOf(row: VersionRow): DocumentVersionView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    value: row.value,
    expiresOn: row.expiresOn ? dayToIso(dayFromDate(row.expiresOn)) : null,
    submittedAt: row.submittedAt.toISOString(),
    reviewedByName: row.reviewedByName,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
  };
}

/** The bank's active documents, asked of every borrower for every product. */
export async function globalDocumentTypes(client: TxClient): Promise<RequiredDocumentType[]> {
  const rows = await client.documentType.findMany({
    where: { scope: 'GLOBAL', status: 'ACTIVE' },
    select: TYPE_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toRequired);
}

async function liveVersions(client: TxClient, borrowerId: string, typeIds: string[]): Promise<VersionRow[]> {
  if (typeIds.length === 0) return [];
  return client.borrowerDocument.findMany({
    where: { borrowerId, documentTypeId: { in: typeIds }, status: { in: LIVE_STATUSES } },
    select: VERSION_SELECT,
  });
}

function itemFor(type: RequiredDocumentType, rows: VersionRow[], todayDay: Day): ChecklistItem {
  const versions = rows
    .filter((r) => r.documentTypeId === type.id)
    .map((r) => ({ row: r, version: r.version, status: r.status, expiresDay: r.expiresOn ? dayFromDate(r.expiresOn) : null }));
  const state = requirementState(versions, todayDay);
  return {
    type,
    status: state.status,
    satisfied: state.satisfied,
    approved: state.approved ? viewOf(state.approved.row) : null,
    pending: state.pending ? viewOf(state.pending.row) : null,
    rejected: state.rejected ? viewOf(state.rejected.row) : null,
  };
}

export async function checklistFor(
  client: TxClient,
  borrowerId: string,
  types: RequiredDocumentType[],
  todayDay: Day = today()
): Promise<ChecklistItem[]> {
  const rows = await liveVersions(client, borrowerId, types.map((t) => t.id));
  return types.map((type) => itemFor(type, rows, todayDay));
}

/**
 * What each product asks of this borrower, and where they stand on it: the
 * bank's documents, then the product's own in the order it lists them. Two
 * type queries and one version query, however many products — the home screen
 * asks for a whole provider at once.
 */
export async function productChecklists(
  client: TxClient,
  borrowerId: string,
  products: { id: string; providerId: string; documentTypeIds: string }[],
  todayDay: Day = today()
): Promise<Map<string, ChecklistItem[]>> {
  const ownIds = [...new Set(products.flatMap((p) => parseDocumentTypeIds(p.documentTypeIds)))];
  const [global, own] = await Promise.all([
    globalDocumentTypes(client),
    ownIds.length
      ? client.documentType.findMany({
          where: { id: { in: ownIds }, scope: 'PRODUCT', status: 'ACTIVE', providerId: { in: [...new Set(products.map((p) => p.providerId))] } },
          select: TYPE_SELECT,
        })
      : Promise.resolve([] as TypeRow[]),
  ]);
  const ownById = new Map(own.map((row) => [row.id, row]));
  const rows = await liveVersions(client, borrowerId, [...global.map((t) => t.id), ...own.map((t) => t.id)]);

  const result = new Map<string, ChecklistItem[]>();
  for (const product of products) {
    const types = [
      ...global,
      ...parseDocumentTypeIds(product.documentTypeIds).flatMap((id) => {
        const row = ownById.get(id);
        // A type is only ever asked for by its own provider's products.
        return row && row.providerId === product.providerId ? [toRequired(row)] : [];
      }),
    ];
    result.set(product.id, types.map((type) => itemFor(type, rows, todayDay)));
  }
  return result;
}

export async function productChecklist(client: TxClient, borrowerId: string, productId: string, todayDay: Day = today()) {
  const product = await client.loanProduct.findUnique({
    where: { id: productId },
    select: { id: true, providerId: true, documentTypeIds: true },
  });
  if (!product) return [];
  return (await productChecklists(client, borrowerId, [product], todayDay)).get(product.id) ?? [];
}

export function borrowerView(item: ChecklistItem): BorrowerDocumentItem {
  return {
    typeId: item.type.id,
    name: item.type.name,
    description: item.type.description,
    kind: item.type.kind,
    requiresExpiry: item.type.requiresExpiry,
    providerName: item.type.providerName,
    status: item.status,
    satisfied: item.satisfied,
    approved: item.approved ? { fileName: item.approved.fileName, value: item.approved.value, expiresOn: item.approved.expiresOn } : null,
    pending: item.pending
      ? { fileName: item.pending.fileName, value: item.pending.value, expiresOn: item.pending.expiresOn, submittedAt: item.pending.submittedAt }
      : null,
    rejected: item.rejected ? { reason: item.rejected.reviewNote } : null,
  };
}

export function outstandingDocuments(items: ChecklistItem[]): ChecklistItem[] {
  return items.filter((item) => !item.satisfied);
}

/** "National ID (waiting for review), Trade licence (needed)". */
export function describeOutstanding(items: ChecklistItem[]): string {
  return items.map((item) => `${item.type.name} (${REQUIREMENT_LABELS[item.status].toLowerCase()})`).join(', ');
}

export function snapshotOf(items: ChecklistItem[]): DocumentSnapshotEntry[] {
  return items.flatMap((item) =>
    item.satisfied && item.approved
      ? [
          {
            documentId: item.approved.id,
            documentTypeId: item.type.id,
            name: item.type.name,
            scope: item.type.scope,
            version: item.approved.version,
            fileName: item.approved.fileName,
            sha256: item.approved.sha256,
            value: item.approved.value,
            expiresOn: item.approved.expiresOn,
            approvedBy: item.approved.reviewedByName,
            approvedAt: item.approved.reviewedAt,
          },
        ]
      : []
  );
}

/**
 * Refuses unless every document the product asks for is approved and in date,
 * and returns what to record as the documents the loan was granted on. Call
 * inside the transaction that creates the loan, so the record matches the check.
 */
export async function requireApprovedDocuments(
  tx: TxClient,
  borrowerId: string,
  productId: string,
  audience: 'BORROWER' | 'REVIEWER'
): Promise<DocumentSnapshotEntry[]> {
  const items = await productChecklist(tx, borrowerId, productId);
  const missing = outstandingDocuments(items);
  if (missing.length) {
    throw new ApiError(
      409,
      audience === 'BORROWER'
        ? `Your documents need to be approved before you can apply: ${describeOutstanding(missing)}.`
        : `The borrower's documents are not all approved: ${describeOutstanding(missing)}.`
    );
  }
  return snapshotOf(items);
}

/**
 * Under Profile → My documents: every bank document, and every provider
 * document the borrower has sent (a provider's document means nothing to them
 * until one of its products asks for it).
 */
export async function profileChecklist(borrowerId: string): Promise<ChecklistItem[]> {
  const sent = await prisma.borrowerDocument.findMany({
    where: { borrowerId, providerId: { not: null }, status: { in: LIVE_STATUSES } },
    select: { documentTypeId: true },
    distinct: ['documentTypeId'],
  });
  const [global, own] = await Promise.all([
    globalDocumentTypes(prisma),
    sent.length
      ? prisma.documentType.findMany({
          where: { id: { in: sent.map((s) => s.documentTypeId) }, status: 'ACTIVE' },
          select: TYPE_SELECT,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        })
      : Promise.resolve([] as TypeRow[]),
  ]);
  return checklistFor(prisma, borrowerId, [...global, ...own.map(toRequired)]);
}

// ----------------------------------------
// Borrower uploads
// ----------------------------------------

export interface DocumentSubmission {
  documentTypeId: string;
  file: { bytes: Uint8Array; name: string } | null;
  value: string | null;
  expiresOn: string | null;
}

/** A provider's document is only worth sending while one of its products asks for it. */
async function askedForByAProduct(typeId: string, providerId: string | null): Promise<boolean> {
  if (!providerId) return false;
  const count = await prisma.loanProduct.count({
    where: { providerId, status: 'ACTIVE', documentTypeIds: { contains: `"${typeId}"` } },
  });
  return count > 0;
}

/**
 * A borrower provides a document, or a new version of one. It waits for review;
 * any approved version stays in effect until the new one is approved, and an
 * earlier version still waiting is withdrawn in its favour.
 */
export async function submitBorrowerDocument(borrower: { id: string; phoneNumber: string }, input: DocumentSubmission) {
  const type = await prisma.documentType.findUnique({ where: { id: input.documentTypeId }, select: TYPE_SELECT });
  if (!type || type.status !== 'ACTIVE') throw new ApiError(404, 'This document is not requested.', 'documentTypeId');
  if (type.scope === 'PRODUCT' && !(await askedForByAProduct(type.id, type.providerId))) {
    throw new ApiError(400, 'No loan asks for this document at the moment.', 'documentTypeId');
  }

  const expiry = parseExpiry(input.expiresOn, today(), type.requiresExpiry);
  if (!expiry.ok) throw new ApiError(400, expiry.error, 'expiresOn');
  const expiresOn = expiry.day === null ? null : dateFromDay(expiry.day);
  const kind = documentKind(type.kind);

  let stored: Awaited<ReturnType<typeof storeDocument>> | null = null;
  let value: string | null = null;
  if (kind === 'TEXT') {
    if (input.file) throw new ApiError(400, `${type.name} is typed in, not uploaded.`, 'file');
    value = (input.value ?? '').trim();
    if (!value) throw new ApiError(400, `Enter your ${type.name}.`, 'value');
    if (value.length > MAX_ANSWER_LENGTH) throw new ApiError(400, `Keep it under ${MAX_ANSWER_LENGTH} characters.`, 'value');
  } else {
    if (!input.file) throw new ApiError(400, `Upload ${type.name} as a file.`, 'file');
    try {
      stored = await storeDocument(input.file.bytes, kind);
    } catch (error) {
      if (error instanceof DocumentError) throw new ApiError(400, error.message, 'file');
      throw error;
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await acquireAppLock(tx, locks.documents(borrower.id));
      const current = await tx.borrowerDocument.findMany({
        where: { borrowerId: borrower.id, documentTypeId: type.id, status: { in: ['PENDING', 'APPROVED'] } },
        select: { status: true, sha256: true, value: true, expiresOn: true },
      });
      const same = current.find(
        (c) =>
          (stored ? c.sha256 === stored.sha256 : c.value === value) &&
          (c.expiresOn?.getTime() ?? null) === (expiresOn?.getTime() ?? null)
      );
      if (same) {
        throw new ApiError(
          409,
          same.status === 'PENDING' ? 'This document is already waiting for review.' : 'This is the document already approved — nothing has changed.',
          kind === 'TEXT' ? 'value' : 'file'
        );
      }
      const replacesApproved = current.some((c) => c.status === 'APPROVED');

      const last = await tx.borrowerDocument.findFirst({
        where: { borrowerId: borrower.id, documentTypeId: type.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const withdrawn = await tx.borrowerDocument.updateMany({
        where: { borrowerId: borrower.id, documentTypeId: type.id, status: 'PENDING' },
        data: { status: 'WITHDRAWN' },
      });
      const created = await tx.borrowerDocument.create({
        data: {
          borrowerId: borrower.id,
          documentTypeId: type.id,
          providerId: type.providerId,
          version: (last?.version ?? 0) + 1,
          status: 'PENDING',
          fileName: stored && input.file ? cleanFileName(input.file.name) : null,
          mimeType: stored?.mimeType ?? null,
          sizeBytes: stored?.sizeBytes ?? null,
          sha256: stored?.sha256 ?? null,
          storageName: stored?.storageName ?? null,
          value,
          expiresOn,
        },
      });

      await createAuditLogInTx(tx, {
        actorId: borrower.phoneNumber,
        actorType: 'BORROWER',
        action: replacesApproved ? 'DOCUMENT_REPLACEMENT_SUBMITTED' : 'DOCUMENT_SUBMITTED',
        entity: 'Borrower',
        entityId: borrower.id,
        details: {
          documentId: created.id,
          documentType: type.name,
          version: created.version,
          // A typed value may be a tax number: its length is enough for the trail.
          ...(stored ? { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mimeType: stored.mimeType } : { length: value?.length }),
          expiresOn: expiryIso(expiry.day),
          withdrewPending: withdrawn.count,
        },
      });
      return { id: created.id, version: created.version, replacesApproved };
    });
  } catch (error) {
    // Nothing points at the file any more; do not leave it on disk.
    if (stored) {
      const path = resolveDocumentPath(stored.storageName);
      if (path) await unlink(path).catch(() => null);
    }
    throw error;
  }
}

// ----------------------------------------
// Review
// ----------------------------------------

/**
 * Who may decide a document: bank documents only bank staff (no provider on
 * their account), a provider's documents only that provider's own staff. Null
 * when this user may.
 */
export function reviewerScopeError(user: Pick<SessionUser, 'providerId'>, documentProviderId: string | null): string | null {
  if (documentProviderId === null) return user.providerId ? 'Bank documents are reviewed by bank staff.' : null;
  return user.providerId === documentProviderId ? null : "Only the lending provider's own staff review this document.";
}

export function canReviewDocument(user: SessionUser, documentProviderId: string | null): boolean {
  return hasPermission(user, 'documents', 'approve') && reviewerScopeError(user, documentProviderId) === null;
}

/** A provider's staff see a borrower once the borrower has applied to it or sent it a document. */
export async function borrowerKnownToProvider(client: TxClient, borrowerId: string, providerId: string): Promise<boolean> {
  const [applications, documents] = await Promise.all([
    client.loanApplication.count({ where: { borrowerId, providerId } }),
    client.borrowerDocument.count({ where: { borrowerId, providerId } }),
  ]);
  return applications + documents > 0;
}

/**
 * Bank staff see every document. A provider's staff see their own documents,
 * and the bank's documents of borrowers they deal with — never another
 * provider's.
 */
export async function canViewBorrowerDocument(
  user: Pick<SessionUser, 'providerId'>,
  doc: { borrowerId: string; providerId: string | null }
): Promise<boolean> {
  if (!user.providerId) return true;
  if (doc.providerId) return doc.providerId === user.providerId;
  return borrowerKnownToProvider(prisma, doc.borrowerId, user.providerId);
}

/** What a reviewer may see of a borrower's documents, as a Prisma filter. */
export function visibleDocumentsWhere(user: Pick<SessionUser, 'providerId'>): Prisma.BorrowerDocumentWhereInput {
  return user.providerId ? { OR: [{ providerId: user.providerId }, { providerId: null }] } : {};
}

export async function reviewBorrowerDocument(
  documentId: string,
  decision: 'APPROVE' | 'REJECT',
  input: { note: string | null; expiresOn: string | null },
  reviewer: SessionUser
) {
  const doc = await prisma.borrowerDocument.findUnique({
    where: { id: documentId },
    include: {
      documentType: { select: { name: true, requiresExpiry: true } },
      borrower: { select: { phoneNumber: true } },
    },
  });
  if (!doc || !(await canViewBorrowerDocument(reviewer, doc))) throw new ApiError(404, 'Document not found.');
  const scopeError = reviewerScopeError(reviewer, doc.providerId);
  if (scopeError) throw new ApiError(403, scopeError);

  const note = input.note?.trim() || null;
  if (decision === 'REJECT' && (!note || note.length < 5)) {
    throw new ApiError(400, 'Tell the borrower why it was not accepted.', 'note');
  }

  // The reviewer has the document in front of them and may correct the date typed.
  let expiresOn = doc.expiresOn;
  if (decision === 'APPROVE' && doc.documentType.requiresExpiry) {
    const typed = input.expiresOn?.trim() || (doc.expiresOn ? dayToIso(dayFromDate(doc.expiresOn)) : '');
    const parsed = parseExpiry(typed, today(), true);
    if (!parsed.ok) throw new ApiError(400, parsed.error, 'expiresOn');
    expiresOn = dateFromDay(parsed.day!);
  }

  const approve = decision === 'APPROVE';
  await prisma.$transaction(async (tx) => {
    await acquireAppLock(tx, locks.documents(doc.borrowerId));
    const claim = await tx.borrowerDocument.updateMany({
      where: { id: doc.id, status: 'PENDING' },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        reviewedById: reviewer.id,
        reviewedByName: reviewer.fullName,
        reviewedAt: new Date(),
        reviewNote: note,
        expiresOn,
      },
    });
    if (claim.count !== 1) {
      const now = await tx.borrowerDocument.findUnique({ where: { id: doc.id }, select: { status: true } });
      throw new ApiError(
        409,
        now?.status === 'WITHDRAWN'
          ? 'The borrower has since sent a newer version. Review that one instead.'
          : 'This document has already been reviewed.'
      );
    }
    const superseded = approve
      ? (
          await tx.borrowerDocument.updateMany({
            where: { borrowerId: doc.borrowerId, documentTypeId: doc.documentTypeId, status: 'APPROVED', NOT: { id: doc.id } },
            data: { status: 'SUPERSEDED' },
          })
        ).count
      : 0;
    await createAuditLogInTx(tx, {
      actorId: reviewer.id,
      actorName: reviewer.fullName,
      action: approve ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED',
      entity: 'Borrower',
      entityId: doc.borrowerId,
      details: {
        documentId: doc.id,
        documentType: doc.documentType.name,
        version: doc.version,
        note,
        expiresOn: expiresOn ? dayToIso(dayFromDate(expiresOn)) : null,
        supersededVersions: superseded,
      },
    });
  });

  void notifyBorrower({
    phone: doc.borrower.phoneNumber,
    template: approve ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED',
    vars: approve ? { document: doc.documentType.name } : { document: doc.documentType.name, reason: note ?? '' },
    entity: 'Borrower',
    entityId: doc.borrowerId,
    providerId: doc.providerId ?? undefined,
  });
}

// ----------------------------------------
// Expiry reminders
// ----------------------------------------

/**
 * Texts borrowers whose approved document expires in the configured number of
 * days, unless a renewal is already waiting for review. Once per business day,
 * from the maintenance pass.
 */
export async function sendDocumentExpiryReminders(day: Day): Promise<number> {
  const settings = await getSettings();
  const daysBefore = Number(settings['notifications.documentExpiryDays']) || 0;
  if (daysBefore <= 0 || !settings['notifications.enabled']) return 0;
  if (!(await isTemplateActive('DOCUMENT_EXPIRING'))) return 0;

  const expiring = await prisma.borrowerDocument.findMany({
    where: { status: 'APPROVED', expiresOn: dateFromDay(day + daysBefore), documentType: { status: 'ACTIVE' }, borrower: { status: 'ACTIVE' } },
    select: {
      borrowerId: true,
      documentTypeId: true,
      providerId: true,
      expiresOn: true,
      documentType: { select: { name: true } },
      borrower: { select: { phoneNumber: true } },
    },
    take: 5000,
  });

  let sent = 0;
  for (const doc of expiring) {
    const renewal = await prisma.borrowerDocument.count({
      where: { borrowerId: doc.borrowerId, documentTypeId: doc.documentTypeId, status: 'PENDING' },
    });
    if (renewal > 0) continue;
    const outcome = await notifyBorrower({
      phone: doc.borrower.phoneNumber,
      template: 'DOCUMENT_EXPIRING',
      vars: { document: doc.documentType.name, expiryDate: formatDay(dayFromDate(doc.expiresOn!)) },
      entity: 'Borrower',
      entityId: doc.borrowerId,
      providerId: doc.providerId ?? undefined,
    });
    if (outcome === 'SENT') sent += 1;
  }
  return sent;
}
