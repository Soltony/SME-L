import { z } from 'zod';
import { boolish } from './lending/terms';
import { readXlsxRows, XlsxError } from './xlsx-reader';
import { containsMarkup } from './plain-text';
import { normalizePhone, isValidEthiopianPhone } from './format';
import { normalizeFieldName } from './lending/scoring';

/**
 * Borrower data a provider uploads for scoring: a declared set of columns, one
 * of which identifies the borrower by phone number, then rows from a
 * spreadsheet or CSV.
 *
 * Each row is validated against the declaration before anything is stored —
 * numbers must be numbers, dates must be dates, the identifier must be a real
 * phone number — and rejected rows are reported back individually rather than
 * silently coerced. The previous import turned any non-numeric text into NaN
 * and stored it.
 */

export const DATA_COLUMN_TYPES = ['string', 'number', 'date'] as const;

export const dataColumnSchema = z.object({
  name: z.string().trim().min(1, 'Name the column.').max(60),
  type: z.enum(DATA_COLUMN_TYPES),
  isIdentifier: boolish,
});

export const dataConfigSchema = z
  .object({
    name: z.string().trim().min(2, 'Name the data set.').max(80),
    columns: z.array(dataColumnSchema).min(2, 'Declare the identifier and at least one data column.').max(60),
  })
  .superRefine((config, ctx) => {
    const identifiers = config.columns.filter((c) => c.isIdentifier);
    if (identifiers.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Mark exactly one column as the phone-number identifier.' });
    }
    const seen = new Set<string>();
    config.columns.forEach((column, index) => {
      const key = normalizeFieldName(column.name);
      if (!key) ctx.addIssue({ code: 'custom', path: ['columns', index, 'name'], message: 'Use letters or digits in the name.' });
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['columns', index, 'name'], message: 'Column names must be unique.' });
      seen.add(key);
    });
  });

export type DataColumn = z.infer<typeof dataColumnSchema>;

export function parseColumns(raw: string): DataColumn[] {
  try {
    const parsed = z.array(dataColumnSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DATA_ROWS = 50_000;

/** A small, strict CSV reader: quoted fields, doubled quotes, CRLF. */
export function readCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_DATA_ROWS + 1) break;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export interface RowRejection {
  row: number;
  reason: string;
}

export interface ParsedUpload {
  totalRows: number;
  accepted: { borrowerKey: string; data: Record<string, string | number> }[];
  rejections: RowRejection[];
}

export class UploadError extends Error {}

function isValidDate(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export function parseUpload(bytes: Uint8Array, fileName: string, columns: DataColumn[]): ParsedUpload {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError('The file is larger than 10 MB.');

  let rows: string[][];
  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith('.xlsx')) rows = readXlsxRows(bytes);
    else if (lower.endsWith('.csv')) rows = readCsvRows(new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''));
    else throw new UploadError('Upload an .xlsx or .csv file.');
  } catch (error) {
    if (error instanceof UploadError) throw error;
    if (error instanceof XlsxError) throw new UploadError(error.message);
    throw new UploadError('The file could not be read.');
  }

  if (rows.length < 2) throw new UploadError('The file has a header row but no data.');
  if (rows.length - 1 > MAX_DATA_ROWS) throw new UploadError(`At most ${MAX_DATA_ROWS.toLocaleString()} rows per upload.`);

  const header = rows[0].map((h) => normalizeFieldName(h));
  const indexOf = new Map<string, number>();
  for (const column of columns) {
    const index = header.indexOf(normalizeFieldName(column.name));
    if (index === -1) throw new UploadError(`The file has no "${column.name}" column.`);
    indexOf.set(column.name, index);
  }
  const identifier = columns.find((c) => c.isIdentifier);
  if (!identifier) throw new UploadError('This data set has no identifier column.');

  const accepted: ParsedUpload['accepted'] = [];
  const rejections: RowRejection[] = [];
  const seen = new Map<string, number>();

  rows.slice(1).forEach((cells, offset) => {
    const rowNumber = offset + 2;
    const rawId = (cells[indexOf.get(identifier.name)!] ?? '').trim();
    const phone = normalizePhone(rawId);
    if (!/^[+]?[0-9 ()-]+$/.test(rawId) || !isValidEthiopianPhone(phone)) {
      rejections.push({ row: rowNumber, reason: `"${rawId.slice(0, 30)}" is not a valid phone number.` });
      return;
    }
    if (seen.has(phone)) {
      rejections.push({ row: rowNumber, reason: `Duplicate of row ${seen.get(phone)} for the same borrower.` });
      return;
    }

    const data: Record<string, string | number> = {};
    for (const column of columns) {
      const value = (cells[indexOf.get(column.name)!] ?? '').trim();
      if (column.isIdentifier) {
        data[column.name] = phone;
        continue;
      }
      if (value === '') continue;
      if (containsMarkup(value)) {
        rejections.push({ row: rowNumber, reason: `${column.name} contains HTML or script markup.` });
        return;
      }
      if (column.type === 'number') {
        const text = value.replace(/,/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(text)) {
          rejections.push({ row: rowNumber, reason: `${column.name} must be a number (got "${value.slice(0, 30)}").` });
          return;
        }
        data[column.name] = Number(text);
      } else if (column.type === 'date') {
        if (!isValidDate(value)) {
          rejections.push({ row: rowNumber, reason: `${column.name} must be a date as YYYY-MM-DD.` });
          return;
        }
        data[column.name] = value;
      } else {
        data[column.name] = value.slice(0, 500);
      }
    }

    seen.set(phone, rowNumber);
    accepted.push({ borrowerKey: phone, data });
  });

  return { totalRows: rows.length - 1, accepted, rejections };
}
