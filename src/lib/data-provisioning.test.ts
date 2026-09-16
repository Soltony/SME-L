import { describe, expect, it } from 'vitest';
import { dataConfigSchema, parseUpload, readCsvRows, UploadError } from './data-provisioning';

const columns = [
  { name: 'Phone', type: 'string' as const, isIdentifier: true },
  { name: 'Monthly revenue', type: 'number' as const, isIdentifier: false },
  { name: 'Registered', type: 'date' as const, isIdentifier: false },
  { name: 'Sector', type: 'string' as const, isIdentifier: false },
];

const csv = (text: string) => new TextEncoder().encode(text);

describe('readCsvRows', () => {
  it('handles quotes, doubled quotes and CRLF', () => {
    expect(readCsvRows('a,"b, c","say ""hi"""\r\n1,2,3\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('parseUpload', () => {
  it('accepts valid rows and reports each bad row with a reason', () => {
    const result = parseUpload(
      csv(
        [
          'phone,MONTHLY_REVENUE,registered,sector',
          '0911223344,"120,000",2020-01-15,Retail',
          '0911223345,lots,2020-01-15,Retail',
          '12345,1000,2020-01-15,Retail',
          '0911223346,5000,2020-02-30,Food',
          '0911223347,5000,,<script>alert(1)</script>',
          '+251911223344,9000,2021-03-01,Food',
        ].join('\n')
      ),
      'profiles.csv',
      columns
    );
    expect(result.totalRows).toBe(6);
    expect(result.accepted).toEqual([
      { borrowerKey: '251911223344', data: { Phone: '251911223344', 'Monthly revenue': 120000, Registered: '2020-01-15', Sector: 'Retail' } },
    ]);
    expect(result.rejections.map((r) => r.row)).toEqual([3, 4, 5, 6, 7]);
    expect(result.rejections[0].reason).toMatch(/must be a number/);
    expect(result.rejections[1].reason).toMatch(/phone/);
    expect(result.rejections[2].reason).toMatch(/date/);
    expect(result.rejections[3].reason).toMatch(/markup/);
    expect(result.rejections[4].reason).toMatch(/Duplicate of row 2/);
  });

  it('refuses a file missing a declared column, or of another type', () => {
    expect(() => parseUpload(csv('phone,sector\n0911223344,Retail'), 'x.csv', columns)).toThrow(UploadError);
    expect(() => parseUpload(csv('anything'), 'x.pdf', columns)).toThrow(/xlsx or \.csv/);
  });
});

describe('dataConfigSchema', () => {
  it('requires exactly one identifier column and unique names', () => {
    expect(dataConfigSchema.safeParse({ name: 'Profile', columns }).success).toBe(true);
    expect(dataConfigSchema.safeParse({ name: 'Profile', columns: columns.map((c) => ({ ...c, isIdentifier: false })) }).success).toBe(false);
    expect(
      dataConfigSchema.safeParse({
        name: 'Profile',
        columns: [columns[0], { name: 'monthly revenue', type: 'number', isIdentifier: false }, columns[1]],
      }).success
    ).toBe(false);
  });
});
