import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { XlsxError, readXlsxRows } from './xlsx-reader';

/**
 * Workbooks are built here rather than committed as fixtures.
 *
 * The reader's job is to survive files nobody would produce on purpose — a
 * part that inflates to gigabytes, a name that climbs out of the archive, a
 * cell called `__proto__` — and those cannot be checked in as a normal
 * spreadsheet. Writing the zip in the test is what makes them expressible.
 */

interface Part {
  name: string;
  content: string;
  /** Overrides the real uncompressed size, to fake a header. */
  declaredSize?: number;
}

function zip(parts: Part[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const raw = Buffer.from(part.content, 'utf8');
    const deflated = deflateRawSync(raw);
    const size = part.declaredSize ?? raw.length;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, deflated);
    centrals.push(central);
    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const WORKBOOK = `<?xml version="1.0"?><workbook><sheets><sheet name="List" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

function sheet(rows: string): string {
  return `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
}

function sharedStrings(values: string[]): string {
  return `<?xml version="1.0"?><sst count="${values.length}">${values
    .map((value) => `<si><t>${value}</t></si>`)
    .join('')}</sst>`;
}

/** A workbook with the given sheet body, and shared strings when supplied. */
function workbook(rows: string, strings?: string[]): Buffer {
  const parts: Part[] = [
    { name: 'xl/workbook.xml', content: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', content: RELS },
    { name: 'xl/worksheets/sheet1.xml', content: sheet(rows) },
  ];
  if (strings) parts.push({ name: 'xl/sharedStrings.xml', content: sharedStrings(strings) });
  return zip(parts);
}

describe('readXlsxRows', () => {
  it('reads inline numbers and shared strings', () => {
    const rows = readXlsxRows(
      workbook(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2"><v>912345678</v></c><c r="B2" t="s"><v>2</v></c></row>`,
        ['phone', 'name', 'Abebe Bekele']
      )
    );

    expect(rows).toEqual([
      ['phone', 'name'],
      ['912345678', 'Abebe Bekele'],
    ]);
  });

  it('keeps a numeric phone cell exactly as stored', () => {
    const rows = readXlsxRows(workbook(`<row r="1"><c r="A1"><v>251912345678</v></c></row>`));
    expect(rows).toEqual([['251912345678']]);
  });

  it('holds a cell at its column, so a blank first column does not shift the row', () => {
    const rows = readXlsxRows(
      workbook(`<row r="1"><c r="B1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row>`, [
        'phone',
        'note',
      ])
    );
    expect(rows).toEqual([['', 'phone', '', 'note']]);
  });

  it('joins the runs of a formatted string and decodes entities', () => {
    const parts: Part[] = [
      { name: 'xl/workbook.xml', content: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      { name: 'xl/worksheets/sheet1.xml', content: sheet(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`) },
      {
        name: 'xl/sharedStrings.xml',
        content: `<sst><si><r><t>Bill</t></r><r><t xml:space="preserve"> &amp; Ben</t></r></si></sst>`,
      },
    ];
    expect(readXlsxRows(zip(parts))).toEqual([['Bill & Ben']]);
  });

  it('reads an inline string cell', () => {
    const rows = readXlsxRows(
      workbook(`<row r="1"><c r="A1" t="inlineStr"><is><t>0912345678</t></is></c></row>`)
    );
    expect(rows).toEqual([['0912345678']]);
  });

  it('drops rows that are entirely empty', () => {
    const rows = readXlsxRows(
      workbook(`<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"/></row>`)
    );
    expect(rows).toEqual([['1']]);
  });

  it('returns a shared-string index past the end of the table as empty', () => {
    const rows = readXlsxRows(
      workbook(`<row r="1"><c r="A1" t="s"><v>99</v></c></row>`, ['only one'])
    );
    expect(rows).toEqual([]);
  });

  it('treats a cell named __proto__ as ordinary text', () => {
    const rows = readXlsxRows(
      workbook(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`, [
        '__proto__',
        'constructor',
      ])
    );
    expect(rows).toEqual([['__proto__', 'constructor']]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('refuses a part whose header claims an implausible expansion', () => {
    const bomb = zip([
      { name: 'xl/workbook.xml', content: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet(''),
        declaredSize: 900 * 1024 * 1024,
      },
    ]);
    expect(() => readXlsxRows(bomb)).toThrow(XlsxError);
  });

  it('refuses a part that is compressed far beyond any real spreadsheet', () => {
    const bomb = zip([
      { name: 'xl/workbook.xml', content: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      { name: 'xl/worksheets/sheet1.xml', content: 'A'.repeat(4 * 1024 * 1024) },
    ]);
    expect(() => readXlsxRows(bomb)).toThrow(/compressed too aggressively/);
  });

  it('refuses a workbook that declares a doctype', () => {
    const attack = zip([
      {
        name: 'xl/workbook.xml',
        content: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${WORKBOOK}`,
      },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      { name: 'xl/worksheets/sheet1.xml', content: sheet('') },
    ]);
    expect(() => readXlsxRows(attack)).toThrow(/unsupported XML declaration/);
  });

  it('ignores a relationship that points outside the archive', () => {
    const attack = zip([
      { name: 'xl/workbook.xml', content: WORKBOOK },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: `<Relationships><Relationship Id="rId1" Target="../../../../etc/passwd"/></Relationships>`,
      },
      { name: 'xl/worksheets/sheet1.xml', content: sheet(`<row r="1"><c r="A1"><v>7</v></c></row>`) },
    ]);
    // Falls back to the real worksheet part rather than reaching for the target.
    expect(readXlsxRows(attack)).toEqual([['7']]);
  });

  it('rejects a file that is not a zip at all', () => {
    expect(() => readXlsxRows(Buffer.from('this is a text file, renamed'))).toThrow(XlsxError);
  });

  it('rejects a zip with no workbook part', () => {
    expect(() => readXlsxRows(zip([{ name: 'hello.txt', content: 'hi' }]))).toThrow(
      /no workbook part/
    );
  });
});
