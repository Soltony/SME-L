import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import type { TxClient } from '@/lib/db-lock';
import { ApiError } from '@/lib/errors';
import { createAuditLog } from '@/lib/audit-log';
import { cleanFileName } from '@/lib/documents';
import { ListUploadError, MAX_LIST_BYTES, parseListFile, type ListEntry, type ParsedList } from '@/lib/eligibility-list';

/**
 * Saved lists of eligible customers.
 *
 * A product with a list attached lends only to the phone numbers on it. The
 * list is uploaded once and reused: every product that points at it follows
 * its current contents, so adding next month's customers is one upload, not one
 * per product.
 *
 * Matching is against every number the borrower has used, the same as scoring
 * data, so a listed customer who has since changed SIM is still recognised.
 */

/** What a borrower who is not on the list is told. */
export const NOT_ON_LIST_MESSAGE = 'This loan is offered to selected customers only, and your number is not on the list.';

/**
 * The multipart form an upload arrives as, with its file parsed. Refuses an
 * oversized body before reading it, so a huge upload is not buffered first.
 */
export async function readListUpload(req: Request): Promise<{ form: FormData; fileName: string; parsed: ParsedList }> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_LIST_BYTES + 64_000) {
    throw new ApiError(413, `The file is larger than ${MAX_LIST_BYTES / 1024 / 1024} MB.`, 'file');
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!form || !(file instanceof File)) throw new ApiError(400, 'Choose a file to upload.', 'file');
  try {
    return { form, fileName: cleanFileName(file.name), parsed: parseListFile(new Uint8Array(await file.arrayBuffer()), file.name) };
  } catch (error) {
    if (error instanceof ListUploadError) throw new ApiError(400, error.message, 'file');
    throw error;
  }
}

/** SQL Server allows 2,100 parameters per statement; an entry row uses five. */
const INSERT_CHUNK = 300;

type Actor = { id: string; fullName: string };

/** Whether any of these numbers is on the list. */
export async function isOnEligibilityList(client: TxClient, listId: string, phoneNumbers: string[]): Promise<boolean> {
  if (phoneNumbers.length === 0) return false;
  const hit = await client.eligibilityListEntry.findFirst({
    where: { listId, phoneNumber: { in: phoneNumbers } },
    select: { id: true },
  });
  return Boolean(hit);
}

/**
 * The products a borrower may see: those with no list, and those whose list
 * holds one of the borrower's numbers. A customer who is not on a list is not
 * shown a loan they would only be refused.
 */
export function visibleToBorrower(phoneNumbers: string[]): Prisma.LoanProductWhereInput {
  return {
    OR: [
      { eligibilityListId: null },
      { eligibilityList: { entries: { some: { phoneNumber: { in: phoneNumbers } } } } },
    ],
  };
}

export interface ListSummary {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  fileName: string | null;
  entryCount: number;
  productCount: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export async function listSummaries(where: Prisma.EligibilityListWhereInput = {}): Promise<ListSummary[]> {
  const rows = await prisma.eligibilityList.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { _count: { select: { entries: true, products: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    description: row.description,
    fileName: row.fileName,
    entryCount: row._count.entries,
    productCount: row._count.products,
    updatedBy: row.updatedBy ?? row.createdBy,
    updatedAt: row.updatedAt,
  }));
}

export interface ImportSummary {
  added: number;
  /** Already on the list (append), so nothing changed for them. */
  unchanged: number;
  /** Taken off by a replace. */
  removed: number;
  duplicatesInFile: number;
  rejected: number;
  total: number;
}

function usable(parsed: ParsedList) {
  if (parsed.entries.length > 0) return;
  throw new ApiError(
    400,
    parsed.rejections.length > 0
      ? `No usable phone numbers were found — ${parsed.rejections.length} row(s) could not be read.`
      : 'No phone numbers were found in the file.',
    'file'
  );
}

async function insertEntries(tx: TxClient, listId: string, entries: ListEntry[]) {
  for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
    await tx.eligibilityListEntry.createMany({
      data: entries.slice(i, i + INSERT_CHUNK).map((e) => ({ listId, phoneNumber: e.phoneNumber, fullName: e.fullName })),
    });
  }
}

/** Long enough for a 50,000-row list; a replace must never be left half-applied. */
const IMPORT_TRANSACTION = { timeout: 180_000, maxWait: 10_000 };

export async function createEligibilityList(input: {
  providerId: string;
  name: string;
  description: string | null;
  fileName: string;
  parsed: ParsedList;
  actor: Actor;
}): Promise<{ id: string; summary: ImportSummary }> {
  usable(input.parsed);
  const clash = await prisma.eligibilityList.findFirst({
    where: { providerId: input.providerId, name: input.name },
    select: { id: true },
  });
  if (clash) throw new ApiError(409, 'This provider already has a list with that name.', 'name');

  const list = await prisma.$transaction(async (tx) => {
    const created = await tx.eligibilityList.create({
      data: {
        providerId: input.providerId,
        name: input.name,
        description: input.description,
        fileName: input.fileName,
        createdById: input.actor.id,
        createdBy: input.actor.fullName,
        updatedById: input.actor.id,
        updatedBy: input.actor.fullName,
      },
      select: { id: true },
    });
    await insertEntries(tx, created.id, input.parsed.entries);
    return created;
  }, IMPORT_TRANSACTION);

  const summary: ImportSummary = {
    added: input.parsed.entries.length,
    unchanged: 0,
    removed: 0,
    duplicatesInFile: input.parsed.duplicates,
    rejected: input.parsed.rejections.length,
    total: input.parsed.entries.length,
  };
  await createAuditLog({
    actorId: input.actor.id,
    actorName: input.actor.fullName,
    action: 'ELIGIBILITY_LIST_CREATED',
    entity: 'EligibilityList',
    entityId: list.id,
    details: { providerId: input.providerId, name: input.name, fileName: input.fileName, ...summary },
  });
  return { id: list.id, summary };
}

/**
 * Loads a new file into an existing list. `replace` makes the list exactly the
 * file; `append` adds the file's customers to those already on it.
 */
export async function importIntoEligibilityList(input: {
  listId: string;
  mode: 'replace' | 'append';
  fileName: string;
  parsed: ParsedList;
  actor: Actor;
}): Promise<ImportSummary> {
  usable(input.parsed);
  const { listId, mode, parsed } = input;

  const existing = new Set(
    (await prisma.eligibilityListEntry.findMany({ where: { listId }, select: { phoneNumber: true } })).map((e) => e.phoneNumber)
  );
  const newcomers = parsed.entries.filter((e) => !existing.has(e.phoneNumber));

  await prisma.$transaction(async (tx) => {
    if (mode === 'replace') await tx.eligibilityListEntry.deleteMany({ where: { listId } });
    await insertEntries(tx, listId, mode === 'replace' ? parsed.entries : newcomers);
    await tx.eligibilityList.update({
      where: { id: listId },
      data: { fileName: input.fileName, updatedById: input.actor.id, updatedBy: input.actor.fullName },
    });
  }, IMPORT_TRANSACTION);

  const incoming = new Set(parsed.entries.map((e) => e.phoneNumber));
  const summary: ImportSummary = {
    added: newcomers.length,
    unchanged: parsed.entries.length - newcomers.length,
    removed: mode === 'replace' ? [...existing].filter((phone) => !incoming.has(phone)).length : 0,
    duplicatesInFile: parsed.duplicates,
    rejected: parsed.rejections.length,
    total: await prisma.eligibilityListEntry.count({ where: { listId } }),
  };

  await createAuditLog({
    actorId: input.actor.id,
    actorName: input.actor.fullName,
    action: 'ELIGIBILITY_LIST_IMPORTED',
    entity: 'EligibilityList',
    entityId: listId,
    details: { mode, fileName: input.fileName, ...summary },
  });
  return summary;
}

/**
 * Deletes a list that no product uses.
 *
 * A list still attached to a product is refused rather than detached: taking
 * the list off would open that product to every borrower, and nobody deleting
 * a spreadsheet means that.
 */
export async function deleteEligibilityList(listId: string, actor: Actor) {
  const list = await prisma.eligibilityList.findUnique({
    where: { id: listId },
    select: { id: true, name: true, products: { select: { name: true } }, _count: { select: { entries: true } } },
  });
  if (!list) throw new ApiError(404, 'List not found.');
  if (list.products.length > 0) {
    throw new ApiError(
      409,
      `${list.name} is used by ${list.products.map((p) => p.name).join(', ')}. Choose another list for ${
        list.products.length === 1 ? 'that product' : 'those products'
      } first.`
    );
  }
  // Entries go with it through the cascade.
  await prisma.eligibilityList.delete({ where: { id: listId } });
  await createAuditLog({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'ELIGIBILITY_LIST_DELETED',
    entity: 'EligibilityList',
    entityId: listId,
    details: { name: list.name, entries: list._count.entries },
  });
}
