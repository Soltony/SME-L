import { describe, expect, it } from 'vitest';
import { acceptAttribute, DocumentError, missingDocuments, parseRequiredDocuments, storeDocument } from './documents';
import { requiredDocumentSchema } from './lending/catalog';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
// A .docx is a zip; its content says nothing about being a document.
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

describe('parseRequiredDocuments', () => {
  it('reads each document with its type', () => {
    expect(parseRequiredDocuments(JSON.stringify([{ key: 'tin', name: 'TIN', type: 'TEXT' }]))).toEqual([
      { key: 'tin', name: 'TIN', description: undefined, type: 'TEXT' },
    ]);
  });

  it('keeps products saved before types existed asking for a photo or PDF', () => {
    expect(parseRequiredDocuments(JSON.stringify([{ key: 'licence', name: 'Licence' }]))[0].type).toBe('FILE');
    expect(parseRequiredDocuments(JSON.stringify([{ key: 'licence', name: 'Licence', type: 'DOCX' }]))[0].type).toBe('FILE');
  });
});

describe('requiredDocumentSchema', () => {
  it('defaults the type, and refuses one that is not offered', () => {
    expect(requiredDocumentSchema.parse({ key: 'licence', name: 'Licence' }).type).toBe('FILE');
    expect(requiredDocumentSchema.safeParse({ key: 'licence', name: 'Licence', type: 'WORD' }).success).toBe(false);
  });
});

describe('storeDocument', () => {
  // Refused before anything is written, so nothing lands on disk.
  it('refuses a PDF where a photo is asked for, and a photo where a PDF is', async () => {
    await expect(storeDocument(PDF, 'IMAGE')).rejects.toThrow('must be a photo');
    await expect(storeDocument(PNG, 'PDF')).rejects.toThrow('must be a PDF');
  });

  it('refuses a file of the right name but the wrong content, whatever is asked for', async () => {
    for (const kind of ['FILE', 'IMAGE', 'PDF', 'TEXT'] as const) {
      await expect(storeDocument(DOCX, kind)).rejects.toBeInstanceOf(DocumentError);
    }
  });
});

describe('acceptAttribute', () => {
  it('offers only the files the type allows', () => {
    expect(acceptAttribute('PDF')).toBe('.pdf,application/pdf');
    expect(acceptAttribute('IMAGE')).toBe('.png,image/png,.jpg,.jpeg,image/jpeg');
  });
});

describe('missingDocuments', () => {
  const required = [
    { key: 'licence', type: 'FILE' as const },
    { key: 'tin', type: 'TEXT' as const },
  ];

  it('counts files for file documents and answers for typed ones', () => {
    expect(missingDocuments(required, { files: ['licence'], answers: ['tin'] })).toEqual([]);
    expect(missingDocuments(required, { files: [], answers: ['tin'] }).map((d) => d.key)).toEqual(['licence']);
  });

  it('asks again when a document changed kind after it was provided', () => {
    expect(missingDocuments(required, { files: ['tin'], answers: ['licence'] }).map((d) => d.key)).toEqual(['licence', 'tin']);
  });
});
