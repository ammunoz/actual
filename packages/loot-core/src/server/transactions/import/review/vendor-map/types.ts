/**
 * Vendor-map types, validation, and pure helpers.
 *
 * The vendor map is a per-budget dictionary of "raw imported payee name →
 * existing budget payee id". It is auto-grown when the user explicitly
 * accepts a fuzzy match or commits an edit that selects an existing payee.
 * Once persisted, subsequent imports resolve the same raw string via Layer 0
 * of the payee resolver without re-running fuzzy.
 *
 * This module is I/O-free: types, schema versioning, and pure helpers.
 *
 * Error messages carry a stable VENDOR-MAP-* code and never echo a
 * user-typed raw payee value.
 */

import type {
  ReviewPayee,
  VendorMap,
} from '#server/transactions/import/review/types';

export const VENDOR_MAP_CURRENT_V = 1;
export const VENDOR_MAP_MIN_SUPPORTED_V = 1;

/** Codes emitted by this module's validation helpers. */
export type VendorMapErrorCode = 'VENDOR-MAP-001';

export class VendorMapValidationError extends Error {
  readonly code: VendorMapErrorCode;
  constructor(code: VendorMapErrorCode, message: string) {
    super(message);
    this.name = 'VendorMapValidationError';
    this.code = code;
  }
}

const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a single entry. The raw name must be a non-empty string; the
 * payee id must be a non-empty string. Returns the normalized entry.
 * Throws `VendorMapValidationError` on failure.
 *
 * Pure.
 */
function validateEntry(
  raw: unknown,
  payeeId: unknown,
): readonly [string, string] {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'entry key must be a non-empty string',
    );
  }
  if (typeof payeeId !== 'string' || payeeId.length === 0) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'entry value must be a non-empty string',
    );
  }
  return [raw, payeeId] as const;
}

/**
 * Validate a full store payload. Returns a freshly-allocated, frozen
 * canonical store. Throws `VendorMapValidationError` on any defect.
 *
 * Pure.
 */
export function validateVendorMap(payload: unknown): VendorMap {
  if (!payload || typeof payload !== 'object') {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'vendor map must be a JSON object',
    );
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.v !== 'number') {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'vendor map must declare numeric v',
    );
  }
  if (p.v < VENDOR_MAP_MIN_SUPPORTED_V || p.v > VENDOR_MAP_CURRENT_V) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      `vendor map version v=${String(p.v)} is outside the supported range [${VENDOR_MAP_MIN_SUPPORTED_V}..${VENDOR_MAP_CURRENT_V}]`,
    );
  }
  if (typeof p.updatedAt !== 'string' || !ISO_DATE_PATTERN.test(p.updatedAt)) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'vendor map must declare ISO-8601 updatedAt',
    );
  }
  if (!p.entries || typeof p.entries !== 'object' || Array.isArray(p.entries)) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'vendor map entries must be an object',
    );
  }

  const entries: Record<string, string> = {};
  for (const [raw, id] of Object.entries(
    p.entries as Record<string, unknown>,
  )) {
    const [k, v] = validateEntry(raw, id);
    entries[k] = v;
  }

  return Object.freeze({
    v: VENDOR_MAP_CURRENT_V,
    updatedAt: p.updatedAt,
    entries: Object.freeze(entries),
  }) as VendorMap;
}

/**
 * Construct a brand-new empty store. `nowIso` is injected for testing.
 */
export function emptyVendorMap(nowIso: string): VendorMap {
  return Object.freeze({
    v: VENDOR_MAP_CURRENT_V,
    updatedAt: nowIso,
    entries: Object.freeze({}),
  }) as VendorMap;
}

/**
 * Pure: produce a new store with `{raw: payeeId}` set (or replaced).
 * Returns a frozen store; the input is not mutated. The caller supplies the
 * timestamp so the helper stays test-deterministic.
 */
export function upsertVendorMapEntry(
  store: VendorMap,
  raw: string,
  payeeId: string,
  nowIso: string,
): VendorMap {
  if (raw.length === 0) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'raw payee name must be non-empty',
    );
  }
  if (payeeId.length === 0) {
    throw new VendorMapValidationError(
      'VENDOR-MAP-001',
      'payee id must be non-empty',
    );
  }
  if (store.entries[raw] === payeeId) return store;
  return Object.freeze({
    v: VENDOR_MAP_CURRENT_V,
    updatedAt: nowIso,
    entries: Object.freeze({ ...store.entries, [raw]: payeeId }),
  }) as VendorMap;
}

/**
 * Pure: drop every entry whose payee id is no longer present in the
 * budget's payee list.
 *
 * A payee deleted in the budget leaves a dangling id behind. The resolver
 * already tolerates a stale entry (it falls through to the next layer), but
 * leaving them in place means the map grows without bound and every import
 * re-checks dead ids. Filtering at load time keeps the map honest without
 * mutating the stored payload.
 *
 * The `updatedAt` timestamp is left untouched: this is a view operation, not
 * a user edit.
 *
 * Pure.
 */
export function filterStaleVendorMapEntries(
  store: VendorMap,
  existingPayees: readonly ReviewPayee[],
): VendorMap {
  const live = new Set(existingPayees.map(p => p.id));
  const entries: Record<string, string> = {};
  let dropped = 0;
  for (const [raw, id] of Object.entries(store.entries)) {
    if (live.has(id)) {
      entries[raw] = id;
    } else {
      dropped += 1;
    }
  }
  if (dropped === 0) return store;
  return Object.freeze({
    v: VENDOR_MAP_CURRENT_V,
    updatedAt: store.updatedAt,
    entries: Object.freeze(entries),
  }) as VendorMap;
}
