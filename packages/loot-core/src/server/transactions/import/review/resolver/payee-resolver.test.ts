import type {
  ReviewAccount,
  ReviewPayee,
  ReviewRowInput,
  VendorMap,
} from '#server/transactions/import/review/types';

import {
  buildFuzzyCache,
  fingerprintPayees,
  fuzzyCacheKey,
} from './payee-cache';
import { resolvePayees } from './payee-resolver';

const FIXED_NOW = '2026-09-07T12:00:00.000Z';

const EXISTING: readonly ReviewPayee[] = [
  { id: 'p-coffee', name: 'Demo Coffee Shop' },
  { id: 'p-grocery', name: 'Demo Grocery' },
  { id: 'p-salary', name: 'Demo Salary Inc' },
  { id: 'p-subs', name: 'Demo Subscriptions' },
  { id: 'p-corp', name: 'Foo Corp' },
  { id: 'p-baz', name: 'Foo Bar Baz' },
];

const ACCOUNTS: readonly ReviewAccount[] = [
  { id: 'a-checking', name: 'Demo Checking' },
  { id: 'a-savings', name: 'Demo Savings' },
];

function mkRow(overrides: Partial<ReviewRowInput> = {}): ReviewRowInput {
  return {
    accountId: 'a-1',
    importedId: 't-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    ...overrides,
  };
}

function mkVendorMap(entries: Record<string, string>): VendorMap {
  return { v: 1, updatedAt: FIXED_NOW, entries };
}

describe('resolvePayees — layer 2 (existing-prefix)', () => {
  it('matches an existing payee with prefix length >= 4 mid-word', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown #12' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('matches an existing payee at a word boundary', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop 1234' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('matches a 3-char existing payee at end-of-string', () => {
    const row = mkRow({ payeeRaw: 'Dem' });
    const existing: readonly ReviewPayee[] = [{ id: 'p-d', name: 'Dem' }];
    const [out] = resolvePayees([row], { existingPayees: existing });
    expect(out?.payeeCanonical).toBe('Dem');
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('does NOT match a 3-char existing payee when no boundary follows', () => {
    const row = mkRow({ payeeRaw: 'DemoVendor' });
    const existing: readonly ReviewPayee[] = [{ id: 'p-d', name: 'Dem' }];
    const [out] = resolvePayees([row], { existingPayees: existing });
    expect(out?.payeeMatchSource).not.toBe('existing-prefix');
  });

  it('existing-prefix wins over strip fallback', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop 4251' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('existing case wins over input case (preserves budget spelling)', () => {
    const row = mkRow({ payeeRaw: 'demo coffee shop downtown' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
  });

  it('longest existing-prefix wins when multiple match', () => {
    const row = mkRow({ payeeRaw: 'Foo Bar Baz Quux' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeCanonical).toBe('Foo Bar Baz');
  });

  it('does not match when existing prefix is longer than txn', () => {
    const row = mkRow({ payeeRaw: 'Foo' });
    const [out] = resolvePayees([row], {
      existingPayees: [{ id: 'p-long', name: 'Foo Corp International' }],
    });
    expect(out?.payeeMatchSource).not.toBe('existing-prefix');
  });
});

describe('resolvePayees — transfer detection', () => {
  it('detects an exact case-insensitive account-name match', () => {
    const row = mkRow({ payeeRaw: 'demo savings' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      accounts: ACCOUNTS,
    });
    expect(out?.payeeMatchSource).toBe('transfer');
    expect(out?.matchedTransferAccountId).toBe('a-savings');
    expect(out?.flags).toEqual([
      expect.objectContaining({
        kind: 'transfer-detected',
        code: 'PAYEE-TRANSFER-001',
      }),
    ]);
  });

  it("never detects a transfer to the row's own account", () => {
    // A transaction cannot transfer to the account it is in. The manual
    // picker refuses it, and the auto-detect has to refuse it too.
    const row = mkRow({ payeeRaw: 'demo savings', accountId: 'a-savings' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      accounts: ACCOUNTS,
    });
    expect(out?.matchedTransferAccountId).toBeUndefined();
    expect(out?.payeeMatchSource).not.toBe('transfer');
  });

  it('transfer detection beats an existing-prefix match on the same string', () => {
    const payees: readonly ReviewPayee[] = [
      { id: 'p-x', name: 'Demo Checking' },
    ];
    const row = mkRow({ payeeRaw: 'Demo Checking' });
    const [out] = resolvePayees([row], {
      existingPayees: payees,
      accounts: ACCOUNTS,
    });
    expect(out?.payeeMatchSource).toBe('transfer');
    expect(out?.matchedTransferAccountId).toBe('a-checking');
  });

  it('an account name is a transfer, even when a payee has that name', () => {
    // There is no layer of user rules: Actual's own rules run during the
    // import, and a second rules system would have to agree with them.
    // So an account name is a transfer even when the budget has a payee
    // with the same name.
    const payees: readonly ReviewPayee[] = [
      { id: 'p-savings', name: 'Demo Savings' },
    ];
    const row = mkRow({ payeeRaw: 'Demo Savings' });
    const [out] = resolvePayees([row], {
      existingPayees: payees,
      accounts: ACCOUNTS,
    });
    expect(out?.payeeMatchSource).toBe('transfer');
    expect(out?.matchedTransferAccountId).toBe('a-savings');
  });

  it('transfer payees are excluded from prefix and fuzzy matching', () => {
    // A transfer payee's display name IS the account name. Letting a vendor
    // string prefix-match it would silently turn an ordinary transaction
    // into a transfer.
    const payees: readonly ReviewPayee[] = [
      { id: 'p-transfer', name: 'Demo Checking', transferAcct: 'a-checking' },
    ];
    const row = mkRow({ payeeRaw: 'Demo Checking Rent' });
    const [out] = resolvePayees([row], {
      existingPayees: payees,
      accounts: [],
      fuzzy: { minScore: 0.5, maxResults: 5 },
    });
    expect(out?.payeeMatchSource).not.toBe('existing-prefix');
    expect(out?.payeeMatchSource).not.toBe('fuzzy');
    expect(out?.matchedPayeeId).toBeUndefined();
  });

  it('an ordinary payee with a NULL transfer_acct is a candidate', () => {
    // Actual's `payees` column is nullable and the API returns `null` for
    // an ordinary payee. A check for `undefined` would exclude EVERY
    // ordinary payee and leave the prefix and fuzzy layers with nothing.
    const payees: readonly ReviewPayee[] = [
      { id: 'p-coffee', name: 'Demo Coffee Shop', transferAcct: null },
    ];
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const [out] = resolvePayees([row], { existingPayees: payees });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
    expect(out?.matchedPayeeId).toBe('p-coffee');
  });

  it('a payee with an undefined transfer_acct is a candidate too', () => {
    const payees: readonly ReviewPayee[] = [
      { id: 'p-coffee', name: 'Demo Coffee Shop' },
    ];
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const [out] = resolvePayees([row], { existingPayees: payees });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('does not alias the caller flags array into the result', () => {
    const flags = [
      { kind: 'duplicate' as const, code: 'FITID-DUP-001' as const },
    ];
    const row = mkRow({ flags });
    const [out] = resolvePayees([row], { existingPayees: [] });
    expect(out?.flags).not.toBe(flags);
    expect(out?.flags).toEqual(flags);
  });
});

describe('resolvePayees — layer 4 (strip fallback) and layer 5 (none)', () => {
  it('falls back to strip when there is no existing-prefix match', () => {
    const row = mkRow({ payeeRaw: 'Demo Unknown Vendor 1234' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeCanonical).toBe('Demo Unknown Vendor');
    expect(out?.payeeMatchSource).toBe('strip-fallback');
  });

  it('returns none when payeeRaw is empty', () => {
    const row = mkRow({ payeeRaw: '' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeMatchSource).toBe('none');
    expect(out?.payeeCanonical).toBe('');
  });

  it('returns none when payeeRaw is whitespace-only', () => {
    const row = mkRow({ payeeRaw: '   ' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeMatchSource).toBe('none');
  });
});

describe('resolvePayees — empty inputs', () => {
  it('returns [] when rows is empty', () => {
    expect(resolvePayees([], { existingPayees: EXISTING })).toEqual([]);
  });

  it('still applies strip fallback when existingPayees is empty', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor' });
    const [out] = resolvePayees([row], { existingPayees: [] });
    expect(out?.payeeMatchSource).toBe('strip-fallback');
    expect(out?.payeeCanonical).toBe('Demo Vendor');
  });
});

describe('resolvePayees — immutability', () => {
  it('does not mutate the input rows array', () => {
    const rows = [mkRow()];
    const copy = [...rows];
    resolvePayees(rows, { existingPayees: EXISTING });
    expect(rows).toEqual(copy);
    expect(rows).toHaveLength(1);
  });

  it('does not mutate the input row object', () => {
    const row = mkRow();
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(row).not.toHaveProperty('payeeCanonical');
    expect(out).not.toBe(row);
  });

  it('does not mutate the input existingPayees array or its items', () => {
    const payees = [...EXISTING];
    const copy = [...payees];
    resolvePayees([mkRow({ payeeRaw: 'Demo Coffee Shop' })], {
      existingPayees: payees,
    });
    expect(payees).toEqual(copy);
  });
});

describe('resolvePayees — multi-row', () => {
  it('resolves multiple rows independently in order', () => {
    const rows = [
      mkRow({ importedId: 't-1', payeeRaw: 'Demo Coffee Shop' }),
      mkRow({ importedId: 't-2', payeeRaw: 'Demo Grocery 4251' }),
      mkRow({ importedId: 't-3', payeeRaw: 'Demo Savings' }),
    ];
    const out = resolvePayees(rows, {
      existingPayees: EXISTING,
      accounts: ACCOUNTS,
    });
    expect(out.map(r => r.payeeMatchSource)).toEqual([
      'existing-prefix',
      'existing-prefix',
      'transfer',
    ]);
    expect(out.map(r => r.importedId)).toEqual(['t-1', 't-2', 't-3']);
  });
});

describe('resolvePayees — flag wiring', () => {
  it('attaches PAYEE-UNK-001 when source is none and existingPayees is non-empty', () => {
    const row = mkRow({ payeeRaw: '   ' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.flags).toEqual([
      { kind: 'unknown-payee', code: 'PAYEE-UNK-001' },
    ]);
  });

  it('does NOT attach PAYEE-UNK-001 when existingPayees is empty (first-run budget)', () => {
    const row = mkRow({ payeeRaw: '   ' });
    const [out] = resolvePayees([row], { existingPayees: [] });
    expect(out?.flags).toEqual([]);
  });

  it('does NOT attach PAYEE-UNK-001 when the payee was matched', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.flags).toEqual([]);
  });

  it('attaches would-create-payee on strip-fallback', () => {
    const row = mkRow({ payeeRaw: 'Demo Unknown Vendor' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.flags).toEqual([
      expect.objectContaining({
        kind: 'would-create-payee',
        code: 'PAYEE-NEW-001',
      }),
    ]);
  });

  it('does NOT attach would-create-payee when existing payee list is empty', () => {
    const row = mkRow({ payeeRaw: 'Demo Unknown Vendor' });
    const [out] = resolvePayees([row], { existingPayees: [] });
    expect(out?.flags).toEqual([]);
  });

  it('input row is not mutated by flag attachment', () => {
    const row = mkRow({ payeeRaw: 'Demo Unknown Vendor' });
    resolvePayees([row], { existingPayees: EXISTING });
    expect(row.flags).toBeUndefined();
  });
});

describe('resolvePayees — Layer 0 (vendor map)', () => {
  it('exact key match wins over the prefix match', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const vendorMap = mkVendorMap({ 'Demo Coffee Shop Downtown': 'p-coffee' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      vendorMap,
    });
    expect(out?.payeeMatchSource).toBe('vendor-map');
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.matchedPayeeId).toBe('p-coffee');
  });

  it('exact key match wins over existing-prefix', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const vendorMap = mkVendorMap({ 'Demo Coffee Shop Downtown': 'p-coffee' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      vendorMap,
    });
    expect(out?.payeeMatchSource).toBe('vendor-map');
  });

  it('falls through when the vendor map has no entry', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const vendorMap = mkVendorMap({ 'UNRELATED RAW': 'p-coffee' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      vendorMap,
    });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('falls through to Layer 2 when vendor map entry points to a missing payee id', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const vendorMap = mkVendorMap({ 'Demo Coffee Shop Downtown': 'p-deleted' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      vendorMap,
    });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('omitting vendorMap keeps the original behavior', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });
});

describe('resolvePayees — Layer 3 (fuzzy)', () => {
  it('attaches fuzzy-payee-match when raw is similar to a budget payee', () => {
    const row = mkRow({ payeeRaw: 'Demo Cofee Shop' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
    });
    expect(out?.payeeMatchSource).toBe('fuzzy');
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.matchedPayeeId).toBe('p-coffee');
    expect(out?.flags).toEqual([
      expect.objectContaining({
        kind: 'fuzzy-payee-match',
        code: 'PAYEE-FUZZY-001',
      }),
    ]);
  });

  it('does not fuzzy-match when canonicalize yields a prefix hit at Layer 2', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const [out] = resolvePayees([row], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
    });
    expect(out?.payeeMatchSource).toBe('existing-prefix');
  });

  it('falls through to strip-fallback when existingPayees is empty (no fuzzy target)', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const [out] = resolvePayees([row], {
      existingPayees: [],
      fuzzy: { minScore: 0.6, maxResults: 5 },
    });
    expect(out?.payeeMatchSource).toBe('strip-fallback');
  });

  it('does not fuzzy-match an unrelated payee at the default threshold', () => {
    // "Demo Grocery Store" against "Online store" scores 0.667, and
    // "Demo Payroll Deposit" against "Home Depot" scores 0.600. Both are
    // wrong, so the default threshold has to be above them.
    const payees: readonly ReviewPayee[] = [
      { id: 'p-online', name: 'Online store' },
      { id: 'p-home', name: 'Home Depot' },
    ];
    const [out] = resolvePayees([mkRow({ payeeRaw: 'Demo Grocery Store' })], {
      existingPayees: payees,
      fuzzy: {},
    });
    expect(out?.payeeMatchSource).not.toBe('fuzzy');
    expect(out?.matchedPayeeId).toBeUndefined();
  });

  it('still fuzzy-matches a genuine typo at the default threshold', () => {
    const payees: readonly ReviewPayee[] = [
      { id: 'p-coffee', name: 'Demo Coffee Shop' },
    ];
    const [out] = resolvePayees([mkRow({ payeeRaw: 'Demo Cofee Shop' })], {
      existingPayees: payees,
      // An empty options object, so the DEFAULT threshold is what applies.
      fuzzy: {},
    });
    expect(out?.payeeMatchSource).toBe('fuzzy');
    expect(out?.matchedPayeeId).toBe('p-coffee');
  });
});

describe('resolvePayees — result shape', () => {
  it('every resolved row carries a flags array', () => {
    const out = resolvePayees([mkRow({ payeeRaw: 'Demo Coffee Shop' })], {
      existingPayees: EXISTING,
    });
    expect(out[0].flags).toEqual([]);
  });

  it('preserves the original row fields on the result', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop', amountCents: -1234 });
    const [out] = resolvePayees([row], { existingPayees: EXISTING });
    expect(out?.importedId).toBe('t-1');
    expect(out?.amountCents).toBe(-1234);
    expect(out?.date).toBe('2026-09-07');
  });
});

describe('resolvePayees — the fuzzy cache', () => {
  /** A row whose vendor string only the FUZZY layer can match. */
  function fuzzyRow(): ReviewRowInput {
    return mkRow({ payeeRaw: 'Demo Cofee Shop' });
  }

  it('returns the same answers with a cache as without', () => {
    // The important one: the cache must not change any answer. A
    // cached flag would be stale, so the cache holds the MATCHES and
    // the flags are still raised fresh every time.
    const rows = [
      fuzzyRow(),
      mkRow({ payeeRaw: 'Demo Coffee Shop' }),
      mkRow({ payeeRaw: 'Demo Grocer' }),
      mkRow({ payeeRaw: 'Nothing Like It At All' }),
    ];

    const without = resolvePayees(rows, {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
    });
    const withCache = resolvePayees(rows, {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: buildFuzzyCache(),
    });

    expect(withCache).toEqual(without);
  });

  it('populates the cache on a resolve', () => {
    const cache = buildFuzzyCache();
    resolvePayees([fuzzyRow()], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    });
    expect(cache.size).toBe(1);
  });

  it('hits the cache on a second resolve with the same payee list', () => {
    const cache = buildFuzzyCache();
    const opts = {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    };

    resolvePayees([fuzzyRow()], opts);
    expect(cache.size).toBe(1);

    // The same row again: the same key, so no new entry.
    resolvePayees([fuzzyRow()], opts);
    expect(cache.size).toBe(1);
  });

  it('serves the CACHED answer, not a freshly computed one', () => {
    // The count alone cannot tell a hit from a recompute-and-overwrite,
    // so the cache is seeded with a sentinel the resolver could not
    // have computed. If the resolver scores the row itself, the answer
    // is the real payee; if it reads the cache, the answer is the
    // sentinel.
    const cache = buildFuzzyCache();
    const fuzzy = { minScore: 0.6, maxResults: 5 };
    const fingerprint = fingerprintPayees(EXISTING);
    cache.set(fingerprint, fuzzyCacheKey(fuzzy, 'Demo Cofee Shop'), [
      { candidate: { id: 'p-sentinel', name: 'Sentinel' }, score: 0.9 },
    ]);

    const [out] = resolvePayees([fuzzyRow()], {
      existingPayees: EXISTING,
      fuzzy,
      fuzzyCache: cache,
    });

    expect(out?.payeeCanonical).toBe('Sentinel');
    expect(out?.payeeMatchSource).toBe('fuzzy');
  });

  it('does not hit a stale entry when the payee list changed', () => {
    // The fingerprint is part of the key, so a changed list cannot hit
    // the old entries — the answer changes with the list.
    const cache = buildFuzzyCache();
    const row = fuzzyRow();

    const before = resolvePayees([row], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    });

    // A DIFFERENT payee list: the old answer would have matched
    // "Demo Coffee Shop", and this one must not.
    const changed: readonly ReviewPayee[] = [
      { id: 'p-other', name: 'Some Other Payee Entirely' },
    ];
    const after = resolvePayees([row], {
      existingPayees: changed,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    });

    expect(before[0]?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(after[0]?.payeeCanonical).not.toBe('Demo Coffee Shop');
    // And the new list has its own entry.
    expect(cache.size).toBe(2);
  });

  it('does not hit a stale entry when a payee became a transfer', () => {
    // The resolver's index EXCLUDES transfer payees from the candidate
    // list, so a payee that became a transfer leaves the candidates.
    // The fingerprint covers the transfer status, so the answer changes.
    const cache = buildFuzzyCache();
    const row = fuzzyRow();

    const before = resolvePayees([row], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    });
    expect(before[0]?.payeeCanonical).toBe('Demo Coffee Shop');

    const withTransfer: readonly ReviewPayee[] = EXISTING.map(payee =>
      payee.id === 'p-coffee'
        ? { ...payee, transferAcct: 'a-checking' }
        : payee,
    );
    const after = resolvePayees([row], {
      existingPayees: withTransfer,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    });

    expect(after[0]?.payeeCanonical).not.toBe('Demo Coffee Shop');
  });

  it('keeps the cache across resolves, so a rule write does not redo the work', () => {
    // The rules are not in the key: a rule write does not change the
    // fuzzy layer's answer, so the cache stays warm across it.
    const cache = buildFuzzyCache();
    const opts = {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
      fuzzyCache: cache,
    };

    resolvePayees([fuzzyRow()], opts);
    resolvePayees([fuzzyRow()], opts);
    resolvePayees([fuzzyRow()], opts);

    // One row, one entry — no matter how many resolves.
    expect(cache.size).toBe(1);
  });

  it('works without a cache at all', () => {
    // Most of the resolver's tests call it with no cache, so the change
    // has to be behaviour-preserving when the cache is absent.
    const [out] = resolvePayees([fuzzyRow()], {
      existingPayees: EXISTING,
      fuzzy: { minScore: 0.6, maxResults: 5 },
    });
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.payeeMatchSource).toBe('fuzzy');
  });
});
