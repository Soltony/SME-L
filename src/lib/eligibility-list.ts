import { readCsvRows } from './data-provisioning';
import { parseEthiopianMobile } from './format';
import { containsMarkup } from './plain-text';
import { readXlsxRows, XlsxError } from './xlsx-reader';

/**
 * Reading an uploaded list of eligible customers.
 *
 * The input is whatever the provider has to hand — usually an Excel sheet
 * exported from their own system, with a phone column somewhere among an
 * account number, a branch and a name. So nothing about the layout is assumed:
 * the phone column is found by its header when it has a recognisable one, and
 * otherwise by looking for the column that actually holds phone numbers.
 *
 * Free of Prisma, so it can be tested on its own. Storing a parsed list is
 * `lending/eligibility-lists.ts`.
 */

export const MAX_LIST_BYTES = 5 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 50_000;
export const LIST_FILE_EXTENSIONS = ['.xlsx', '.xlsm', '.csv', '.txt'];

export class ListUploadError extends Error {}

export interface ListEntry {
  /** 251XXXXXXXXX, the form borrower phone numbers are stored in. */
  phoneNumber: string;
  fullName: string | null;
}

export interface ListRejection {
  /** 1-based row in the spreadsheet, so the operator can find it. */
  row: number;
  value: string;
  reason: string;
}

export interface ParsedList {
  entries: ListEntry[];
  rejections: ListRejection[];
  /** Rows dropped because the same number appeared earlier in the file. */
  duplicates: number;
  /** Data rows read, excluding the header and blank rows. */
  totalRows: number;
}

/** Headers the phone column may carry, compared lowercased with spaces and punctuation removed. */
const PHONE_HEADERS = new Set([
  'phone',
  'phonenumber',
  'phoneno',
  'mobile',
  'mobilenumber',
  'mobileno',
  'msisdn',
  'telephone',
  'tel',
  'cellphone',
  'contact',
  'contactnumber',
  'ስልክ',
  'ስልክቁጥር',
]);
const NAME_HEADERS = new Set(['name', 'fullname', 'customer', 'customername', 'borrower', 'borrowername', 'accountname', 'ስም']);

const MAX_NAME_LENGTH = 120;
/** Rows sampled when no header names the phone column. */
const SAMPLE_ROWS = 50;

const headerKey = (cell: string) => cell.toLowerCase().replace(/[\s_.\-#:]/g, '');
const cellText = (row: string[], index: number) => (index >= 0 ? String(row[index] ?? '').trim() : '');

/**
 * A cell's value as a stored phone number, or null when it is not one.
 *
 * Mobile numbers only (09 / 07), the numbers borrowers sign in with. That is
 * also what stops a nine-digit account-number column from passing for phones.
 */
export function phoneFromCell(raw: string): string | null {
  return parseEthiopianMobile(raw);
}

/** Rows of cells from an uploaded file. */
export function readListFile(bytes: Uint8Array, fileName: string): string[][] {
  if (bytes.byteLength === 0) throw new ListUploadError('The file is empty.');
  if (bytes.byteLength > MAX_LIST_BYTES) {
    throw new ListUploadError(`The file is larger than ${MAX_LIST_BYTES / 1024 / 1024} MB.`);
  }
  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXlsxRows(bytes);
    if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
      return readCsvRows(new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''));
    }
  } catch (error) {
    if (error instanceof XlsxError) throw new ListUploadError(error.message);
    throw new ListUploadError('The file could not be read. Save it as .xlsx or .csv and try again.');
  }
  throw new ListUploadError('Upload an Excel (.xlsx) or .csv file.');
}

/**
 * Where the phone and name columns are, and whether the first row is a header.
 *
 * A recognised header wins. Without one, the phone column is whichever column
 * holds the most valid numbers in the first rows — which also covers the
 * simplest file of all, a single column of numbers — and a first row that is
 * not a number there is taken to be a header nobody gave a standard name.
 */
function locateColumns(rows: string[][]): { phone: number; name: number; hasHeader: boolean } {
  const first = rows[0] ?? [];
  const headers = first.map((cell) => headerKey(String(cell ?? '')));
  const phoneByHeader = headers.findIndex((h) => PHONE_HEADERS.has(h));
  const nameByHeader = headers.findIndex((h) => NAME_HEADERS.has(h));
  if (phoneByHeader !== -1) return { phone: phoneByHeader, name: nameByHeader, hasHeader: true };

  const width = rows.slice(0, SAMPLE_ROWS + 1).reduce((max, row) => Math.max(max, row.length), 0);
  let phone = 0;
  let best = -1;
  for (let column = 0; column < width; column += 1) {
    const hits = rows.slice(0, SAMPLE_ROWS + 1).filter((row) => phoneFromCell(cellText(row, column))).length;
    if (hits > best) {
      best = hits;
      phone = column;
    }
  }
  const hasHeader = rows.length > 1 && !phoneFromCell(cellText(first, phone));
  return { phone, name: hasHeader ? nameByHeader : -1, hasHeader };
}

/** Rows of cells to eligible customers, with every refused row explained. */
export function rowsToListEntries(input: string[][]): ParsedList {
  // Row numbers are reported against the file, so blank rows are skipped
  // without being removed.
  const numbered = input
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter(({ cells }) => cells.some((cell) => String(cell ?? '').trim() !== ''));
  if (numbered.length === 0) throw new ListUploadError('The file has no rows.');

  const columns = locateColumns(numbered.map((r) => r.cells));
  const body = columns.hasHeader ? numbered.slice(1) : numbered;
  if (body.length === 0) throw new ListUploadError('The file has a header row but no customers.');
  if (body.length > MAX_LIST_ENTRIES) {
    throw new ListUploadError(
      `The file has ${body.length.toLocaleString('en-US')} rows. A list holds at most ${MAX_LIST_ENTRIES.toLocaleString('en-US')}.`
    );
  }

  const entries: ListEntry[] = [];
  const rejections: ListRejection[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const { cells, row } of body) {
    const raw = cellText(cells, columns.phone);
    if (!raw) {
      rejections.push({ row, value: '', reason: 'No phone number in this row.' });
      continue;
    }
    const phoneNumber = phoneFromCell(raw);
    if (!phoneNumber) {
      rejections.push({ row, value: raw.slice(0, 40), reason: 'Not an Ethiopian mobile number, such as 0911223344.' });
      continue;
    }
    const fullName = cellText(cells, columns.name).slice(0, MAX_NAME_LENGTH);
    // A spreadsheet does not pass through readJsonBody, so the markup rule is
    // applied here. Checked before the number counts as seen, so a refused row
    // cannot shadow a good row for the same customer further down.
    if (containsMarkup(fullName)) {
      rejections.push({ row, value: raw.slice(0, 40), reason: 'The name contains HTML or script tags.' });
      continue;
    }
    if (seen.has(phoneNumber)) {
      duplicates += 1;
      continue;
    }
    seen.add(phoneNumber);
    entries.push({ phoneNumber, fullName: fullName || null });
  }

  return { entries, rejections, duplicates, totalRows: body.length };
}

export function parseListFile(bytes: Uint8Array, fileName: string): ParsedList {
  return rowsToListEntries(readListFile(bytes, fileName));
}

/** The starting point an operator can download and fill in. */
export const LIST_TEMPLATE_HEADER = ['phone', 'name'];
export const LIST_TEMPLATE_ROWS = [
  ['0911223344', 'Abebe Bekele'],
  ['251922334455', 'Sara Tesfaye'],
];
