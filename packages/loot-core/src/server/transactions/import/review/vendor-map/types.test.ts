import type {
  ReviewPayee,
  VendorMap,
} from '#server/transactions/import/review/types';

import {
  emptyVendorMap,
  filterStaleVendorMapEntries,
  upsertVendorMapEntry,
  validateVendorMap,
  VENDOR_MAP_CURRENT_V,
  VENDOR_MAP_MIN_SUPPORTED_V,
  VendorMapValidationError,
} from './types';

const FIXED_NOW = '2026-09-07T12:00:00.000Z';

function mkMap(entries: Record<string, string> = {}): VendorMap {
  return { v: 1, updatedAt: FIXED_NOW, entries };
}

describe('validateVendorMap', () => {
  it('accepts a well-formed map', () => {
    const out = validateVendorMap({
      v: 1,
      updatedAt: FIXED_NOW,
      entries: { 'Demo Vendor': 'p-1' },
    });
    expect(out.v).toBe(VENDOR_MAP_CURRENT_V);
    expect(out.entries['Demo Vendor']).toBe('p-1');
  });

  it('rejects a non-object payload', () => {
    expect(() => validateVendorMap(null)).toThrow(VendorMapValidationError);
    expect(() => validateVendorMap('nope')).toThrow(VendorMapValidationError);
  });

  it('rejects a missing version', () => {
    expect(() =>
      validateVendorMap({ updatedAt: FIXED_NOW, entries: {} }),
    ).toThrow(VendorMapValidationError);
  });

  it('rejects an out-of-range version', () => {
    expect(() =>
      validateVendorMap({ v: 99, updatedAt: FIXED_NOW, entries: {} }),
    ).toThrow(VendorMapValidationError);
    expect(() =>
      validateVendorMap({ v: 0, updatedAt: FIXED_NOW, entries: {} }),
    ).toThrow(VendorMapValidationError);
  });

  it('rejects a missing or malformed updatedAt', () => {
    expect(() => validateVendorMap({ v: 1, entries: {} })).toThrow(
      VendorMapValidationError,
    );
    expect(() =>
      validateVendorMap({ v: 1, updatedAt: 'not-a-date', entries: {} }),
    ).toThrow(VendorMapValidationError);
  });

  it('rejects non-object entries', () => {
    expect(() =>
      validateVendorMap({ v: 1, updatedAt: FIXED_NOW, entries: [] }),
    ).toThrow(VendorMapValidationError);
  });

  it('rejects an empty entry key or value', () => {
    expect(() =>
      validateVendorMap({ v: 1, updatedAt: FIXED_NOW, entries: { '': 'p-1' } }),
    ).toThrow(VendorMapValidationError);
    expect(() =>
      validateVendorMap({ v: 1, updatedAt: FIXED_NOW, entries: { Demo: '' } }),
    ).toThrow(VendorMapValidationError);
  });

  it('the error carries a stable code', () => {
    try {
      validateVendorMap(null);
    } catch (err) {
      expect((err as VendorMapValidationError).code).toBe('VENDOR-MAP-001');
    }
  });

  it('the error message never echoes a user-typed raw name', () => {
    try {
      validateVendorMap({
        v: 1,
        updatedAt: FIXED_NOW,
        entries: { 'Demo Secret Vendor': '' },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('Demo Secret Vendor');
    }
  });

  it('the supported version range is coherent', () => {
    expect(VENDOR_MAP_MIN_SUPPORTED_V).toBeLessThanOrEqual(
      VENDOR_MAP_CURRENT_V,
    );
  });
});

describe('emptyVendorMap', () => {
  it('builds an empty map with the supplied timestamp', () => {
    const out = emptyVendorMap(FIXED_NOW);
    expect(out.entries).toEqual({});
    expect(out.updatedAt).toBe(FIXED_NOW);
  });
});

describe('upsertVendorMapEntry', () => {
  it('adds an entry', () => {
    const out = upsertVendorMapEntry(mkMap(), 'Demo Vendor', 'p-1', FIXED_NOW);
    expect(out.entries['Demo Vendor']).toBe('p-1');
  });

  it('replaces an existing entry', () => {
    const store = mkMap({ 'Demo Vendor': 'p-1' });
    const out = upsertVendorMapEntry(store, 'Demo Vendor', 'p-2', FIXED_NOW);
    expect(out.entries['Demo Vendor']).toBe('p-2');
  });

  it('returns the same store when nothing changed', () => {
    const store = mkMap({ 'Demo Vendor': 'p-1' });
    expect(upsertVendorMapEntry(store, 'Demo Vendor', 'p-1', FIXED_NOW)).toBe(
      store,
    );
  });

  it('does not mutate the input store', () => {
    const store = mkMap();
    upsertVendorMapEntry(store, 'Demo Vendor', 'p-1', FIXED_NOW);
    expect(store.entries).toEqual({});
  });

  it('rejects an empty raw name or payee id', () => {
    const store = mkMap();
    expect(() => upsertVendorMapEntry(store, '', 'p-1', FIXED_NOW)).toThrow(
      VendorMapValidationError,
    );
    expect(() => upsertVendorMapEntry(store, 'Demo', '', FIXED_NOW)).toThrow(
      VendorMapValidationError,
    );
  });
});

describe('filterStaleVendorMapEntries', () => {
  const payees: readonly ReviewPayee[] = [
    { id: 'p-1', name: 'Demo Coffee Shop' },
    { id: 'p-2', name: 'Demo Grocery' },
  ];

  it('drops entries whose payee no longer exists', () => {
    const store = mkMap({ 'Demo Vendor': 'p-1', 'Demo Ghost': 'p-deleted' });
    const out = filterStaleVendorMapEntries(store, payees);
    expect(out.entries).toEqual({ 'Demo Vendor': 'p-1' });
  });

  it('keeps the store unchanged when nothing is stale', () => {
    const store = mkMap({ 'Demo Vendor': 'p-1' });
    expect(filterStaleVendorMapEntries(store, payees)).toBe(store);
  });

  it('preserves the updatedAt timestamp (a view operation, not a user edit)', () => {
    const store = mkMap({ 'Demo Ghost': 'p-deleted' });
    expect(filterStaleVendorMapEntries(store, payees).updatedAt).toBe(
      FIXED_NOW,
    );
  });

  it('does not mutate the input store', () => {
    const store = mkMap({ 'Demo Ghost': 'p-deleted' });
    filterStaleVendorMapEntries(store, payees);
    expect(store.entries).toEqual({ 'Demo Ghost': 'p-deleted' });
  });

  it('drops every entry when no payees exist', () => {
    const store = mkMap({ 'Demo Vendor': 'p-1' });
    expect(filterStaleVendorMapEntries(store, []).entries).toEqual({});
  });
});
