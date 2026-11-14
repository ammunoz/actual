import { readVendorMap, toReviewRows } from './use-import-review';

describe('toReviewRows', () => {
  it('reads the FITID from imported_id', () => {
    const rows = toReviewRows([
      { imported_id: 'FITID-1', date: '2026-09-07', amount: -2500 },
    ]);
    expect(rows[0].importedId).toBe('FITID-1');
  });

  it('leaves importedId undefined when the file has no FITID', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -2500 }]);
    expect(rows[0].importedId).toBeUndefined();
  });

  it('reads the raw vendor string from imported_payee', () => {
    const rows = toReviewRows([
      { imported_payee: 'POS PURCHASE 4251', date: '2026-09-07', amount: -1 },
    ]);
    expect(rows[0].payeeRaw).toBe('POS PURCHASE 4251');
  });

  it('falls back to payee_name when imported_payee is absent', () => {
    const rows = toReviewRows([
      { payee_name: 'Demo Vendor', date: '2026-09-07', amount: -1 },
    ]);
    expect(rows[0].payeeRaw).toBe('Demo Vendor');
  });

  it('uses an empty payee when the file has neither', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -1 }]);
    expect(rows[0].payeeRaw).toBe('');
  });

  it('assigns a unique previewKey to every row', () => {
    const rows = toReviewRows([
      { date: '2026-09-07', amount: -1 },
      { date: '2026-09-07', amount: -2 },
      { date: '2026-09-07', amount: -3 },
    ]);
    const keys = rows.map(r => r.previewKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('assigns a previewKey even when the FITIDs repeat', () => {
    const rows = toReviewRows([
      { imported_id: 'SAME', date: '2026-09-07', amount: -1 },
      { imported_id: 'SAME', date: '2026-09-07', amount: -2 },
    ]);
    expect(rows[0].previewKey).not.toBe(rows[1].previewKey);
  });

  it('keeps the amount as integer cents', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -2500 }]);
    expect(rows[0].amountCents).toBe(-2500);
  });

  it('falls back to 0 for a non-numeric amount', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: 'oops' }]);
    expect(rows[0].amountCents).toBe(0);
  });

  it('reads the bank memo', () => {
    const rows = toReviewRows([
      { date: '2026-09-07', amount: -1, notes: 'a bank note' },
    ]);
    expect(rows[0].memo).toBe('a bank note');
  });

  it('handles an empty list', () => {
    expect(toReviewRows([])).toEqual([]);
  });
});

describe('readVendorMap', () => {
  it('is undefined for an unset preference', () => {
    expect(readVendorMap(undefined)).toBeUndefined();
  });

  it('is undefined for an empty string', () => {
    expect(readVendorMap('')).toBeUndefined();
  });

  it('parses a well-formed map', () => {
    const raw = JSON.stringify({
      v: 1,
      updatedAt: '2026-09-07T12:00:00.000Z',
      entries: { 'Demo Vendor': 'p-1' },
    });
    expect(readVendorMap(raw)?.entries['Demo Vendor']).toBe('p-1');
  });

  it('is undefined for malformed JSON rather than throwing', () => {
    expect(readVendorMap('{not json')).toBeUndefined();
  });

  it('is undefined for a well-formed JSON that fails validation', () => {
    expect(readVendorMap(JSON.stringify({ v: 99 }))).toBeUndefined();
  });
});
