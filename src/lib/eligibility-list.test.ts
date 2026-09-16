import { describe, expect, it } from 'vitest';
import { ListUploadError, MAX_LIST_ENTRIES, parseListFile, readListFile, rowsToListEntries } from './eligibility-list';

const csv = (text: string) => new TextEncoder().encode(text);

describe('rowsToListEntries', () => {
  it('reads the phone and name columns by header, wherever they are', () => {
    const parsed = rowsToListEntries([
      ['No', 'Account', 'Customer Name', 'Mobile No.'],
      ['1', '1000900101', 'Abebe Bekele', '0911223344'],
      ['2', '1000900102', 'Sara Tesfaye', '+251 922 334 455'],
    ]);
    expect(parsed.entries).toEqual([
      { phoneNumber: '251911223344', fullName: 'Abebe Bekele' },
      { phoneNumber: '251922334455', fullName: 'Sara Tesfaye' },
    ]);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.rejections).toEqual([]);
  });

  it('accepts every way a number turns up in a spreadsheet', () => {
    // 911223344 is what Excel leaves when it drops the leading zero.
    const parsed = rowsToListEntries([['phone'], ['0911223344'], ['911223344'], ['251911223344'], ['0711223344']]);
    expect(parsed.entries.map((e) => e.phoneNumber)).toEqual(['251911223344', '251711223344']);
    expect(parsed.duplicates).toBe(2);
  });

  it('finds the phone column without a recognised header', () => {
    const parsed = rowsToListEntries([
      ['Branch', 'Acct', 'Tel. of customer'],
      ['Bole', '100090010', '0911000001'],
      ['Piassa', '100090011', '0911000002'],
    ]);
    // The nine-digit account numbers are not mobiles, so they are not mistaken for the phone column.
    expect(parsed.entries.map((e) => e.phoneNumber)).toEqual(['251911000001', '251911000002']);
    expect(parsed.rejections).toEqual([]);
  });

  it('takes a bare column of numbers, with no header at all', () => {
    const parsed = rowsToListEntries([['0911000001'], ['0911000002']]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].fullName).toBeNull();
  });

  it('reports refused rows against their row number in the file', () => {
    const parsed = rowsToListEntries([
      ['phone', 'name'],
      ['0911000001', 'Good'],
      ['', ''],
      ['12345', 'Too short'],
      ['', 'No number'],
      ['0911000002', '<script>alert(1)</script>'],
    ]);
    expect(parsed.entries.map((e) => e.phoneNumber)).toEqual(['251911000001']);
    expect(parsed.rejections).toEqual([
      { row: 4, value: '12345', reason: expect.stringContaining('mobile') },
      { row: 5, value: '', reason: 'No phone number in this row.' },
      { row: 6, value: '0911000002', reason: expect.stringContaining('HTML') },
    ]);
  });

  it('does not let a refused row hide a later good row for the same number', () => {
    const parsed = rowsToListEntries([
      ['phone', 'name'],
      ['0911000001', '<b>x</b>'],
      ['0911000001', 'Abebe'],
    ]);
    expect(parsed.entries).toEqual([{ phoneNumber: '251911000001', fullName: 'Abebe' }]);
    expect(parsed.duplicates).toBe(0);
  });

  it('refuses a file with nothing in it, or only a header', () => {
    expect(() => rowsToListEntries([['', '']])).toThrow(ListUploadError);
    expect(() => rowsToListEntries([['phone', 'name']])).toThrow('header row but no customers');
  });

  it('refuses more rows than a list holds', () => {
    const rows = [['phone'], ...Array.from({ length: MAX_LIST_ENTRIES + 1 }, () => ['0911000001'])];
    expect(() => rowsToListEntries(rows)).toThrow('at most');
  });
});

describe('readListFile', () => {
  it('reads a CSV, including one saved with a BOM', () => {
    const parsed = parseListFile(csv('﻿phone,name\r\n0911223344,"Bekele, Abebe"\r\n'), 'list.csv');
    expect(parsed.entries).toEqual([{ phoneNumber: '251911223344', fullName: 'Bekele, Abebe' }]);
  });

  it('refuses files it cannot read', () => {
    expect(() => readListFile(csv(''), 'list.csv')).toThrow('empty');
    expect(() => readListFile(csv('phone'), 'list.docx')).toThrow('.xlsx');
    expect(() => readListFile(csv('not a zip at all, honestly'), 'list.xlsx')).toThrow(ListUploadError);
  });
});
