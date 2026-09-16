import { inflateRawSync } from 'zlib';

/**
 * Reading the first worksheet of an uploaded `.xlsx` into rows of text.
 *
 * This replaces ExcelJS, which was pulled in for exactly one job — turning a
 * spreadsheet of phone numbers into cells — and brought a dependency chain
 * (`unzipper`, `archiver` → `glob` → `inflight`, an old `uuid`) with no
 * maintained release to upgrade to. A workbook we accept is untrusted input
 * from an operator's browser, so the reader it goes through is worth owning:
 * everything below works on the bytes already in memory, writes nothing to
 * disk, and refuses anything outside the shape a participant list can take.
 *
 * What that rules out, by construction:
 *
 *  - Archive expansion attacks. Every entry is checked against a per-entry
 *    ceiling, a whole-archive ceiling and a compression-ratio ceiling *before*
 *    it is inflated, so a small file cannot expand into an unbounded one.
 *  - Path traversal on extraction. Nothing is extracted. Four entries are
 *    looked up by exact name and inflated into memory; a name carrying `..`
 *    or an absolute path simply never matches one.
 *  - Prototype pollution. Rows are plain arrays and cells are strings. No key
 *    from the file is ever used to index an object, so `__proto__` in a cell
 *    is a nine-character string and nothing else.
 *  - XXE and entity expansion. The XML is scanned, not parsed by a general
 *    parser: only the elements named here are recognised, a `<!DOCTYPE>` is a
 *    hard refusal, and the five predefined entities plus numeric references
 *    are the only substitutions performed.
 *  - Embedded media. Images, links and external references are not read.
 */

/** Nothing legitimate in a participant workbook is anywhere near this. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Everything we inflate, added up. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Deflate rarely beats this on spreadsheet XML; a zip bomb needs far more. */
const MAX_COMPRESSION_RATIO = 200;
/** A central directory longer than this is not a spreadsheet. */
const MAX_ENTRIES = 2_000;
/** Rows and cells actually handed back. */
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 64;
const MAX_CELL_LENGTH = 4_000;
const MAX_SHARED_STRINGS = 500_000;

export class XlsxError extends Error {}

// ----------------------------------------
// ZIP
// ----------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Locates the end-of-central-directory record.
 *
 * It sits at the tail, behind a comment of up to 64 KiB, so it can only be
 * found by scanning backwards — and the scan is bounded to that comment length
 * so a file full of near-miss signature bytes cannot make this walk the whole
 * buffer.
 */
function findEocd(buffer: Buffer): number {
  const limit = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= limit; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  throw new XlsxError('Not a valid .xlsx file (no zip directory).');
}

/**
 * Where the central directory starts and how many entries it holds.
 *
 * The 32-bit fields saturate at 0xFFFF / 0xFFFFFFFF, at which point the real
 * values live in a Zip64 record ahead of the locator. Small workbooks never
 * need it, but some writers emit Zip64 unconditionally, so it is read rather
 * than refused.
 */
function readDirectoryLocation(buffer: Buffer, eocd: number) {
  let entryCount = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);

  const saturated = entryCount === 0xffff || directoryOffset === 0xffffffff;
  if (!saturated) return { entryCount, directoryOffset };

  const locator = eocd - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
    throw new XlsxError('Not a valid .xlsx file (missing zip64 locator).');
  }

  const record = Number(buffer.readBigUInt64LE(locator + 8));
  if (!Number.isSafeInteger(record) || record < 0 || record + 56 > buffer.length) {
    throw new XlsxError('Not a valid .xlsx file (bad zip64 offset).');
  }
  if (buffer.readUInt32LE(record) !== SIG_EOCD64) {
    throw new XlsxError('Not a valid .xlsx file (bad zip64 record).');
  }

  entryCount = Number(buffer.readBigUInt64LE(record + 32));
  directoryOffset = Number(buffer.readBigUInt64LE(record + 48));
  return { entryCount, directoryOffset };
}

/**
 * The Zip64 extra field, which carries whichever of the three 64-bit values
 * their 32-bit counterparts could not hold. Order is fixed and each is present
 * only when its short form was saturated, so they are consumed in sequence.
 */
function applyZip64Extra(
  extra: Buffer,
  entry: { compressedSize: number; uncompressedSize: number; localHeaderOffset: number }
) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = cursor + 4;
    if (body + size > extra.length) return;

    if (id === 0x0001) {
      let field = body;
      const take = () => {
        const value = Number(extra.readBigUInt64LE(field));
        field += 8;
        return value;
      };
      if (entry.uncompressedSize === 0xffffffff && field + 8 <= body + size) {
        entry.uncompressedSize = take();
      }
      if (entry.compressedSize === 0xffffffff && field + 8 <= body + size) {
        entry.compressedSize = take();
      }
      if (entry.localHeaderOffset === 0xffffffff && field + 8 <= body + size) {
        entry.localHeaderOffset = take();
      }
      return;
    }
    cursor = body + size;
  }
}

/** The central directory, as a map from entry name to its header. */
function readCentralDirectory(buffer: Buffer): Map<string, ZipEntry> {
  const eocd = findEocd(buffer);
  const { entryCount, directoryOffset } = readDirectoryLocation(buffer, eocd);

  if (entryCount > MAX_ENTRIES) {
    throw new XlsxError('The workbook contains too many parts to be read safely.');
  }
  if (directoryOffset < 0 || directoryOffset >= buffer.length) {
    throw new XlsxError('Not a valid .xlsx file (bad directory offset).');
  }

  const entries = new Map<string, ZipEntry>();
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) break;

    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength + commentLength > buffer.length) break;

    const entry: ZipEntry = {
      // Zip names are UTF-8 in every writer that matters here; a mis-decoded
      // name only means the part is not one of the four we look up.
      name: buffer.toString('utf8', nameStart, extraStart),
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
    };

    if (extraLength > 0) {
      applyZip64Extra(buffer.subarray(extraStart, extraStart + extraLength), entry);
    }

    // First writer wins. A second entry under the same name is the classic way
    // to show one part to a validator and feed another to the reader.
    if (!entries.has(entry.name)) entries.set(entry.name, entry);

    cursor = extraStart + extraLength + commentLength;
  }

  return entries;
}

/**
 * Inflates one entry, refusing anything that would expand out of proportion.
 *
 * The declared uncompressed size is checked first because it is free, but it is
 * also attacker-controlled, so `maxOutputLength` re-imposes the same ceiling on
 * zlib itself: a header that lies about its size cannot buy more memory than a
 * header that tells the truth.
 */
function inflateEntry(buffer: Buffer, entry: ZipEntry, budget: { remaining: number }): string {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new XlsxError('The workbook uses an unsupported compression method.');
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.uncompressedSize > budget.remaining) {
    throw new XlsxError('The workbook expands to more data than can be read safely.');
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
  ) {
    throw new XlsxError('The workbook is compressed too aggressively to be read safely.');
  }

  const header = entry.localHeaderOffset;
  if (header < 0 || header + 30 > buffer.length || buffer.readUInt32LE(header) !== SIG_LOCAL) {
    throw new XlsxError('Not a valid .xlsx file (bad local header).');
  }

  // The local header's own name and extra lengths are the ones that apply here;
  // the central directory's extra field is a different length in most writers.
  const dataStart =
    header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new XlsxError('Not a valid .xlsx file (truncated entry).');

  const raw = buffer.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    output =
      entry.method === 0
        ? Buffer.from(raw)
        : inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, budget.remaining) });
  } catch {
    throw new XlsxError('The workbook could not be decompressed.');
  }

  budget.remaining -= output.length;
  if (budget.remaining < 0) {
    throw new XlsxError('The workbook expands to more data than can be read safely.');
  }
  return output.toString('utf8');
}

// ----------------------------------------
// XML
// ----------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Resolves the entity references XLSX actually uses.
 *
 * Only the five predefined names and numeric references are substituted, and
 * nothing is looked up in the document, so a custom entity declaration has
 * nothing to expand into. Anything unrecognised is left as literal text.
 */
function decodeXmlText(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, reference: string) => {
    if (reference[0] === '#') {
      const hex = reference[1] === 'x' || reference[1] === 'X';
      const code = hex ? parseInt(reference.slice(2), 16) : parseInt(reference.slice(1), 10);
      // Surrogate halves and out-of-range values would throw; a spreadsheet has
      // no business emitting them, so the reference is kept as written.
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[reference] ?? match;
  });
}

/** Refuses a document that declares a doctype, which we would never honour. */
function rejectDoctype(xml: string) {
  if (/<!DOCTYPE/i.test(xml)) {
    throw new XlsxError('The workbook contains an unsupported XML declaration.');
  }
}

/** Reads one double-quoted attribute off an element's opening tag. */
function attribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return match ? match[1] : null;
}

/**
 * Text of every `<t>` inside one shared-string `<si>`, concatenated.
 *
 * A string split across formatting runs arrives as several `<t>` elements, so
 * they are joined. `<rPh>` holds furigana for East Asian text — a parallel
 * reading of the same characters — and is dropped so it does not appear twice.
 */
function sharedStringText(si: string): string {
  const withoutPhonetics = si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  const pattern = /<t\b[^>]*?(\/>|>([\s\S]*?)<\/t>)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutPhonetics)) !== null) {
    if (match[1] !== '/>') text += decodeXmlText(match[2] ?? '');
    if (text.length > MAX_CELL_LENGTH) break;
  }
  return text.slice(0, MAX_CELL_LENGTH);
}

function readSharedStrings(xml: string): string[] {
  rejectDoctype(xml);
  const strings: string[] = [];
  const pattern = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    strings.push(match[1] === undefined ? '' : sharedStringText(match[1]));
    if (strings.length >= MAX_SHARED_STRINGS) break;
  }
  return strings;
}

/** `A` -> 0, `Z` -> 25, `AA` -> 26. Returns -1 for a reference we cannot read. */
function columnIndex(reference: string): number {
  let index = 0;
  for (let position = 0; position < reference.length; position += 1) {
    const code = reference.charCodeAt(position);
    if (code < 65 || code > 90) return -1;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/**
 * One cell as text.
 *
 * `t` says how to read it: `s` indexes the shared-string table, `inlineStr`
 * carries its own `<t>`, `str` is a cached formula result, and everything else
 * — numbers, dates, booleans — is the literal `<v>`. A number is returned as
 * written rather than reformatted, which is what keeps a phone number typed
 * into a numeric cell from being rounded on the way through.
 */
function cellText(cell: string, attributes: string, sharedStrings: string[]): string {
  const type = attribute(attributes, 't') ?? 'n';

  if (type === 'inlineStr') {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cell);
    return inline ? sharedStringText(inline[1]) : '';
  }

  const value = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(cell);
  if (!value || value[1] === undefined) return '';
  const raw = decodeXmlText(value[1]).slice(0, MAX_CELL_LENGTH);

  if (type === 's') {
    const index = Number(raw);
    // Bounds are checked rather than trusted: an index past the table is how a
    // crafted sheet would try to read something that is not there.
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) return '';
    return sharedStrings[index];
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return '';
  return raw;
}

/**
 * Rows of a worksheet, with empty cells preserved in place.
 *
 * Position matters: a sheet whose first column is blank must not shift the
 * phone number into column A, or the header detection downstream reads the
 * wrong column. Each cell is placed at the index its `r` reference gives.
 */
function readSheetRows(xml: string, sharedStrings: string[]): string[][] {
  rejectDoctype(xml);
  const rows: string[][] = [];

  const rowPattern = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    if (rows.length >= MAX_ROWS) break;
    const body = rowMatch[1];
    if (!body) continue;

    const cells: string[] = [];
    let nextIndex = 0;

    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const attributes = cellMatch[1];
      const reference = attribute(attributes, 'r');
      const letters = reference ? /^([A-Z]+)/.exec(reference) : null;
      const declared = letters ? columnIndex(letters[1]) : -1;
      const index = declared >= 0 ? declared : nextIndex;
      if (index >= MAX_COLUMNS) continue;

      while (cells.length < index) cells.push('');
      const text =
        cellMatch[2] === undefined ? '' : cellText(cellMatch[2], attributes, sharedStrings);
      if (cells.length === index) cells.push(text);
      else cells[index] = text;
      nextIndex = index + 1;
    }

    if (cells.some((cell) => cell !== '')) rows.push(cells);
  }

  return rows;
}

// ----------------------------------------
// WORKBOOK
// ----------------------------------------

/**
 * Which part holds the first worksheet.
 *
 * The name is not fixed — `sheet1.xml` is a convention, not a rule — so the
 * first `<sheet>` in the workbook is resolved through the relationship table,
 * exactly as a spreadsheet application would. The resolved target is only ever
 * used as a lookup key against the directory read above, so a relationship
 * pointing outside the archive finds nothing rather than reaching anywhere.
 */
function firstSheetPart(workbookXml: string, relsXml: string, entries: Map<string, ZipEntry>) {
  rejectDoctype(workbookXml);
  rejectDoctype(relsXml);

  const sheet = /<sheet\b[^>]*\/?>/.exec(workbookXml);
  const relationshipId = sheet ? attribute(sheet[0], 'r:id') ?? attribute(sheet[0], 'id') : null;

  if (relationshipId) {
    const pattern = /<Relationship\b[^>]*\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(relsXml)) !== null) {
      if (attribute(match[0], 'Id') !== relationshipId) continue;
      const target = attribute(match[0], 'Target');
      if (!target) break;
      const name = decodeXmlText(target).replace(/^\/?(xl\/)?/, 'xl/');
      if (entries.has(name)) return name;
      break;
    }
  }

  // No usable relationship: fall back to the conventional name, then to the
  // lowest-numbered worksheet part present.
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  const worksheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort();
  return worksheets[0] ?? null;
}

/**
 * Reads the first worksheet of an `.xlsx` / `.xlsm` workbook into rows of text.
 *
 * Only the first sheet is read. A workbook whose list is on a second tab comes
 * back empty rather than half-imported, and the caller reports the row count so
 * that shows up as "nothing found" rather than as a silent success.
 */
export function readXlsxRows(data: ArrayBuffer | Buffer | Uint8Array): string[][] {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));

  if (buffer.length < 22) throw new XlsxError('The file is too small to be a workbook.');
  if (buffer.readUInt32LE(0) !== SIG_LOCAL) {
    throw new XlsxError('Not a valid .xlsx file (missing zip signature).');
  }

  const entries = readCentralDirectory(buffer);
  const budget = { remaining: MAX_TOTAL_BYTES };
  const read = (name: string): string | null => {
    const entry = entries.get(name);
    return entry ? inflateEntry(buffer, entry, budget) : null;
  };

  const workbookXml = read('xl/workbook.xml');
  if (!workbookXml) throw new XlsxError('Not a valid .xlsx file (no workbook part).');

  const sheetName = firstSheetPart(workbookXml, read('xl/_rels/workbook.xml.rels') ?? '', entries);
  if (!sheetName) return [];

  const sheetXml = read(sheetName);
  if (!sheetXml) return [];

  // Only loaded when the sheet references it — a workbook of numbers has none.
  const sharedStrings = sheetXml.includes('t="s"')
    ? readSharedStrings(read('xl/sharedStrings.xml') ?? '')
    : [];

  return readSheetRows(sheetXml, sharedStrings);
}
