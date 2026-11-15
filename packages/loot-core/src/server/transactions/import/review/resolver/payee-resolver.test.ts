import type {
  ReviewAccount,
  ReviewPayee,
  ReviewPayeeRule,
  ReviewRowInput,
  VendorMap,
} from '#server/transactions/import/review/types';

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

function mkRule(overrides: Partial<ReviewPayeeRule> = {}): ReviewPayeeRule {
  return {
    pattern: 'Demo',
    patternKind: 'contains',
    canonicalName: 'Demo Canonical',
    enabled: true,
    ...overrides,
  };
}

function mkVendorMap(entries: Record<string, string>): VendorMap {
  return { v: 1, updatedAt: FIXED_NOW, entries };
}

describe('resolvePayees — layer 1 (rules)', () => {
  it('matches a `contains` rule', () => {
    const row = mkRow({ payeeRaw: 'POS PURCHASE 9999 Demo Vendor Co.' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Vendor', canonicalName: 'Demo Vendor Co.' }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeCanonical).toBe('Demo Vendor Co.');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('matches `contains` case-insensitively', () => {
    const row = mkRow({ payeeRaw: 'POS PURCHASE 9999 demo vendor co.' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'DEMO VENDOR', canonicalName: 'Demo Vendor Co.' }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeCanonical).toBe('Demo Vendor Co.');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('matches a `prefix` rule', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor Inc.' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          patternKind: 'prefix',
          pattern: 'Demo Vendor',
          canonicalName: 'Demo Vendor Co.',
        }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeCanonical).toBe('Demo Vendor Co.');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('matches a `regex` rule with `i` flag', () => {
    const row = mkRow({ payeeRaw: 'demo vendor 123' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          patternKind: 'regex',
          pattern: '^demo\\s+vendor\\s+\\d+$',
          patternFlags: 'i',
          canonicalName: 'Demo Vendor Co.',
        }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeCanonical).toBe('Demo Vendor Co.');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('matches a `regex` rule without `i` flag case-sensitively', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor 123' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          patternKind: 'regex',
          pattern: '^demo vendor \\d+$',
          canonicalName: 'Demo Vendor Co.',
        }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeMatchSource).toBe('strip-fallback');
  });

  it('skips disabled rules', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          pattern: 'Demo Vendor',
          canonicalName: 'Demo Vendor Co.',
          enabled: false,
        }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeMatchSource).not.toBe('rule');
    expect(out?.payeeCanonical).toBe('Demo Vendor');
  });

  it('longest-rule wins when multiple rules match', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const short = mkRule({ pattern: 'Demo', canonicalName: 'Demo Short' });
    const long = mkRule({
      pattern: 'Demo Coffee Shop',
      canonicalName: 'Demo Coffee Shop',
    });
    const [out] = resolvePayees([row], {
      rules: [short, long],
      existingPayees: [],
    });
    expect(out?.payeeCanonical).toBe('Demo Coffee Shop');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('rule beats existing-prefix even when prefix is longer', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const [out] = resolvePayees([row], {
      rules: [mkRule({ pattern: 'Demo', canonicalName: 'Demo From Rule' })],
      existingPayees: EXISTING,
    });
    expect(out?.payeeCanonical).toBe('Demo From Rule');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('propagates rule.categoryId to ResolvedRow.matchedCategoryId', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor Co.' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          pattern: 'Demo Vendor',
          canonicalName: 'Demo Vendor Co.',
          categoryId: 'demo-c-rent',
        }),
      ],
      existingPayees: [],
    });
    expect(out?.matchedCategoryId).toBe('demo-c-rent');
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('omits matchedCategoryId when the rule has no categoryId', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor Co.' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Vendor', canonicalName: 'Demo Vendor Co.' }),
      ],
      existingPayees: [],
    });
    expect(out?.matchedCategoryId).toBeUndefined();
    expect('matchedCategoryId' in (out ?? {})).toBe(false);
  });
});

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

  it('a rule beats transfer detection (a rule mapping an account name is deliberate)', () => {
    const row = mkRow({ payeeRaw: 'Demo Savings' });
    const [out] = resolvePayees([row], {
      rules: [mkRule({ pattern: 'Demo Savings', canonicalName: 'Demo Payee' })],
      existingPayees: EXISTING,
      accounts: ACCOUNTS,
    });
    expect(out?.payeeMatchSource).toBe('rule');
    expect(out?.matchedTransferAccountId).toBeUndefined();
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
      { kind: 'needs-review' as const, code: 'FITID-DUP-001' as const },
    ];
    const row = mkRow({ flags });
    const [out] = resolvePayees([row], { existingPayees: [] });
    expect(out?.flags).not.toBe(flags);
    expect(out?.flags).toEqual(flags);
  });

  it('skips a rule whose pattern is not a valid regular expression', () => {
    // A broken rule must not abort the whole import.
    const row = mkRow({ payeeRaw: 'Demo Vendor' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({
          patternKind: 'regex',
          pattern: '([unclosed',
          canonicalName: 'Demo From Rule',
        }),
      ],
      existingPayees: EXISTING,
    });
    expect(out?.payeeMatchSource).not.toBe('rule');
  });
});

describe('resolvePayees — layer 3 (strip fallback) and layer 4 (none)', () => {
  it('falls back to strip when no rule and no existing-prefix match', () => {
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

  it('still applies rules + strip fallback when existingPayees is empty', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Vendor', canonicalName: 'Demo Vendor Co.' }),
      ],
      existingPayees: [],
    });
    expect(out?.payeeMatchSource).toBe('rule');
  });

  it('still applies strip fallback when both existingPayees and rules are empty', () => {
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

  it('does not mutate the input rules array', () => {
    const rules = [
      mkRule({ pattern: 'Demo Vendor', canonicalName: 'Demo Vendor Co.' }),
    ];
    const copy = [...rules];
    resolvePayees([mkRow({ payeeRaw: 'Demo Vendor' })], {
      rules,
      existingPayees: EXISTING,
    });
    expect(rules).toEqual(copy);
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

  it('does NOT attach PAYEE-UNK-001 when source is rule', () => {
    const row = mkRow({ payeeRaw: 'Demo Vendor' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Vendor', canonicalName: 'Demo Vendor Co.' }),
      ],
      existingPayees: EXISTING,
    });
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
  it('exact key match wins over user rules', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop Downtown' });
    const vendorMap = mkVendorMap({ 'Demo Coffee Shop Downtown': 'p-coffee' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Coffee', canonicalName: 'WRONG RULE HIT' }),
      ],
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

  it('falls through to Layer 1 when vendor map has no entry', () => {
    const row = mkRow({ payeeRaw: 'Demo Coffee Shop' });
    const vendorMap = mkVendorMap({ 'UNRELATED RAW': 'p-coffee' });
    const [out] = resolvePayees([row], {
      rules: [
        mkRule({ pattern: 'Demo Coffee', canonicalName: 'Demo Coffee Shop' }),
      ],
      existingPayees: EXISTING,
      vendorMap,
    });
    expect(out?.payeeMatchSource).toBe('rule');
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
