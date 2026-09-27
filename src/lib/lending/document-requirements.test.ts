import { describe, expect, it } from 'vitest';
import { isoToDay } from '@/lib/business-date';
import { parseDocumentSnapshot, parseDocumentTypeIds, parseExpiry, requirementState } from './document-requirements';

const TODAY = isoToDay('2026-09-27');
const v = (version: number, status: string, expires?: string) => ({
  version,
  status,
  expiresDay: expires ? isoToDay(expires) : null,
});

describe('requirementState', () => {
  it('asks for a document nobody has sent', () => {
    expect(requirementState([], TODAY)).toMatchObject({ status: 'MISSING', satisfied: false, approved: null });
  });

  it('waits on a first upload, and counts it once approved', () => {
    expect(requirementState([v(1, 'PENDING')], TODAY)).toMatchObject({ status: 'PENDING', satisfied: false });
    expect(requirementState([v(1, 'APPROVED')], TODAY)).toMatchObject({ status: 'APPROVED', satisfied: true });
  });

  it('keeps the approved version in effect while a replacement waits', () => {
    const state = requirementState([v(1, 'APPROVED'), v(2, 'PENDING')], TODAY);
    expect(state).toMatchObject({ status: 'APPROVED', satisfied: true });
    expect(state.approved?.version).toBe(1);
    expect(state.pending?.version).toBe(2);
  });

  it('keeps the approved version when its replacement is rejected, and says so', () => {
    const state = requirementState([v(1, 'APPROVED'), v(2, 'REJECTED')], TODAY);
    expect(state).toMatchObject({ status: 'APPROVED', satisfied: true });
    expect(state.rejected?.version).toBe(2);
  });

  it('does not report a rejection older than the approved version', () => {
    expect(requirementState([v(1, 'REJECTED'), v(2, 'APPROVED')], TODAY).rejected).toBeNull();
  });

  it('asks again after a rejection when nothing was approved', () => {
    expect(requirementState([v(1, 'REJECTED')], TODAY)).toMatchObject({ status: 'REJECTED', satisfied: false });
  });

  it('counts a document on its expiry day, and not the day after', () => {
    expect(requirementState([v(1, 'APPROVED', '2026-09-27')], TODAY).satisfied).toBe(true);
    expect(requirementState([v(1, 'APPROVED', '2026-09-26')], TODAY)).toMatchObject({ status: 'EXPIRED', satisfied: false });
  });

  it('shows a renewal of an expired document as waiting, not expired', () => {
    expect(requirementState([v(1, 'APPROVED', '2026-01-01'), v(2, 'PENDING', '2027-01-01')], TODAY).status).toBe('PENDING');
  });

  it('ignores history that no longer counts', () => {
    expect(requirementState([v(1, 'SUPERSEDED'), v(2, 'WITHDRAWN')], TODAY).status).toBe('MISSING');
  });
});

describe('parseExpiry', () => {
  it('requires a date only when the document type asks for one', () => {
    expect(parseExpiry('', TODAY, false)).toEqual({ ok: true, day: null });
    expect(parseExpiry('', TODAY, true).ok).toBe(false);
  });

  it('accepts today or later and refuses an expired document', () => {
    expect(parseExpiry('2026-09-27', TODAY, true)).toEqual({ ok: true, day: TODAY });
    expect(parseExpiry('2026-09-26', TODAY, true)).toMatchObject({ ok: false, error: expect.stringContaining('already expired') });
  });

  it('refuses dates that are not real, or absurdly far ahead', () => {
    expect(parseExpiry('2026-02-30', TODAY, true).ok).toBe(false);
    expect(parseExpiry('27/09/2027', TODAY, true).ok).toBe(false);
    expect(parseExpiry('2199-01-01', TODAY, true).ok).toBe(false);
  });
});

describe('stored values', () => {
  it('reads a product document list, dropping duplicates and junk', () => {
    expect(parseDocumentTypeIds('["a","b","a",3,""]')).toEqual(['a', 'b']);
    expect(parseDocumentTypeIds('not json')).toEqual([]);
    expect(parseDocumentTypeIds(null)).toEqual([]);
  });

  it('reads a snapshot, skipping entries that are not documents', () => {
    const raw = JSON.stringify([{ documentId: 'd1', name: 'TIN', version: 1 }, { nope: true }]);
    expect(parseDocumentSnapshot(raw).map((e) => e.documentId)).toEqual(['d1']);
    expect(parseDocumentSnapshot(undefined)).toEqual([]);
  });
});
