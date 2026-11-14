import type {
  Flag,
  FlagKind,
  ResolvedRow,
  TrustLevel,
} from '#server/transactions/import/review/types';

import { flagFor, gateByTrustLevel, outcomeFor } from './flags';

function mkRow(overrides: Partial<ResolvedRow> = {}): ResolvedRow {
  return {
    accountId: 'a-1',
    importedId: 't-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    payeeCanonical: '',
    payeeMatchSource: 'none',
    flags: [],
    ...overrides,
  };
}

describe('flagFor', () => {
  it('returns a new row with a single flag appended', () => {
    const row = mkRow();
    const out = flagFor(row, 'unknown-payee', 'PAYEE-UNK-001');
    expect(out.flags).toEqual([
      { kind: 'unknown-payee', code: 'PAYEE-UNK-001' },
    ]);
  });

  it('preserves the note field when provided', () => {
    const row = mkRow();
    const out = flagFor(
      row,
      'payee-rule-conflict',
      'PAYEE-RULE-001',
      'r-a|r-b',
    );
    expect(out.flags).toEqual([
      { kind: 'payee-rule-conflict', code: 'PAYEE-RULE-001', note: 'r-a|r-b' },
    ]);
  });

  it('omits the note field when undefined (no `note: undefined` leakage)', () => {
    const row = mkRow();
    const out = flagFor(row, 'duplicate', 'FITID-DUP-001');
    const flag = out.flags?.[0] as Flag;
    expect(flag.note).toBeUndefined();
    expect('note' in flag).toBe(false);
  });

  it('appends to existing flags (additive)', () => {
    const row = mkRow();
    const once = flagFor(row, 'unknown-payee', 'PAYEE-UNK-001');
    const twice = flagFor(once, 'duplicate', 'FITID-DUP-001');
    expect(twice.flags).toEqual([
      { kind: 'unknown-payee', code: 'PAYEE-UNK-001' },
      { kind: 'duplicate', code: 'FITID-DUP-001' },
    ]);
  });

  it('does not mutate the input row object', () => {
    const row = mkRow();
    flagFor(row, 'unknown-payee', 'PAYEE-UNK-001');
    expect(row.flags).toEqual([]);
  });

  it('does not mutate the input flags array', () => {
    const seeded = mkRow({
      flags: [{ kind: 'date-out-of-range', code: 'DATE-RANGE-001' }],
    });
    const flagsRef = seeded.flags;
    const out = flagFor(seeded, 'duplicate', 'FITID-DUP-001');
    expect(seeded.flags).toBe(flagsRef);
    expect(seeded.flags).toEqual([
      { kind: 'date-out-of-range', code: 'DATE-RANGE-001' },
    ]);
    expect(out.flags).not.toBe(flagsRef);
    expect(out.flags).toHaveLength(2);
  });

  it('produces a fresh flags array on each call', () => {
    const a = flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001');
    const b = flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001');
    expect(a.flags).not.toBe(b.flags);
  });

  it('preserves caller-added fields (e.g. matchedPayeeId)', () => {
    const row = mkRow();
    const flagged = { ...row, matchedPayeeId: 'p-1' };
    const out = flagFor(flagged, 'unknown-payee', 'PAYEE-UNK-001');
    expect(
      (out as ResolvedRow & { matchedPayeeId: string }).matchedPayeeId,
    ).toBe('p-1');
  });
});

describe('outcomeFor (matrix lookup)', () => {
  const KINDS: readonly FlagKind[] = [
    'unknown-payee',
    'payee-rule-conflict',
    'amount-mismatch',
    'date-out-of-range',
    'needs-review',
    'duplicate',
    'fuzzy-payee-match',
    'would-create-payee',
    'transfer-detected',
  ];
  const LEVELS: readonly TrustLevel[] = ['paranoid', 'cautious', 'trusted'];

  const EXPECTED: Readonly<
    Record<FlagKind, Readonly<Record<TrustLevel, 'block' | 'skip' | 'warn'>>>
  > = {
    'unknown-payee': { paranoid: 'block', cautious: 'block', trusted: 'warn' },
    'payee-rule-conflict': {
      paranoid: 'block',
      cautious: 'block',
      trusted: 'warn',
    },
    'amount-mismatch': {
      paranoid: 'block',
      cautious: 'block',
      trusted: 'warn',
    },
    'date-out-of-range': {
      paranoid: 'block',
      cautious: 'block',
      trusted: 'warn',
    },
    'needs-review': { paranoid: 'block', cautious: 'warn', trusted: 'warn' },
    duplicate: { paranoid: 'block', cautious: 'skip', trusted: 'skip' },
    'fuzzy-payee-match': {
      paranoid: 'block',
      cautious: 'warn',
      trusted: 'warn',
    },
    'would-create-payee': {
      paranoid: 'warn',
      cautious: 'warn',
      trusted: 'warn',
    },
    'transfer-detected': {
      paranoid: 'warn',
      cautious: 'warn',
      trusted: 'warn',
    },
  };

  for (const kind of KINDS) {
    for (const trust of LEVELS) {
      it(`${kind} + ${trust} -> ${EXPECTED[kind][trust]}`, () => {
        expect(outcomeFor(kind, trust)).toBe(EXPECTED[kind][trust]);
      });
    }
  }
});

describe('gateByTrustLevel', () => {
  it('returns empty buckets for empty input', () => {
    const out = gateByTrustLevel([], 'cautious');
    expect(out).toEqual({ blocked: [], skipped: [], warned: [] });
  });

  it('puts a row with no flags in `warned`', () => {
    const row = mkRow();
    const out = gateByTrustLevel([row], 'paranoid');
    expect(out.blocked).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.warned).toEqual([row]);
  });

  it('paranoid blocks every kind', () => {
    const KINDS: readonly FlagKind[] = [
      'unknown-payee',
      'payee-rule-conflict',
      'amount-mismatch',
      'date-out-of-range',
      'needs-review',
      'duplicate',
    ];
    const rows = KINDS.map(k =>
      flagFor(mkRow({ importedId: `t-${k}` }), k, 'PAYEE-UNK-001'),
    );
    const out = gateByTrustLevel(rows, 'paranoid');
    expect(out.blocked).toHaveLength(6);
    expect(out.skipped).toHaveLength(0);
    expect(out.warned).toHaveLength(0);
  });

  it('cautious: duplicate -> skip, others block or warn', () => {
    const dupRow = flagFor(
      mkRow({ importedId: 't-dup' }),
      'duplicate',
      'FITID-DUP-002',
    );
    const unkRow = flagFor(
      mkRow({ importedId: 't-unk' }),
      'unknown-payee',
      'PAYEE-UNK-001',
    );
    const revRow = flagFor(
      mkRow({ importedId: 't-rev' }),
      'needs-review',
      'AMT-MISMATCH-001',
    );
    const out = gateByTrustLevel([dupRow, unkRow, revRow], 'cautious');
    expect(out.skipped.map(r => r.importedId)).toEqual(['t-dup']);
    expect(out.blocked.map(r => r.importedId)).toEqual(['t-unk']);
    expect(out.warned.map(r => r.importedId)).toEqual(['t-rev']);
  });

  it('trusted: duplicate -> skip, every other kind -> warn', () => {
    const dupRow = flagFor(
      mkRow({ importedId: 't-dup' }),
      'duplicate',
      'FITID-DUP-002',
    );
    const amtRow = flagFor(
      mkRow({ importedId: 't-amt' }),
      'amount-mismatch',
      'AMT-MISMATCH-001',
    );
    const unkRow = flagFor(
      mkRow({ importedId: 't-unk' }),
      'unknown-payee',
      'PAYEE-UNK-001',
    );
    const out = gateByTrustLevel([dupRow, amtRow, unkRow], 'trusted');
    expect(out.skipped.map(r => r.importedId)).toEqual(['t-dup']);
    expect(out.warned.map(r => r.importedId).sort()).toEqual([
      't-amt',
      't-unk',
    ]);
    expect(out.blocked).toHaveLength(0);
  });

  it('multi-flag priority: block wins over skip', () => {
    const row = flagFor(
      flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001'),
      'duplicate',
      'FITID-DUP-001',
    );
    const out = gateByTrustLevel([row], 'cautious');
    expect(out.blocked).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
    expect(out.warned).toHaveLength(0);
  });

  it('multi-flag priority: skip wins over warn', () => {
    const row = flagFor(
      flagFor(mkRow(), 'duplicate', 'FITID-DUP-001'),
      'amount-mismatch',
      'AMT-MISMATCH-001',
    );
    const out = gateByTrustLevel([row], 'trusted');
    expect(out.blocked).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.warned).toHaveLength(0);
  });

  it('multi-flag: warn + warn -> warned', () => {
    const row = flagFor(
      flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001'),
      'amount-mismatch',
      'AMT-MISMATCH-001',
    );
    const out = gateByTrustLevel([row], 'trusted');
    expect(out.blocked).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
    expect(out.warned).toHaveLength(1);
  });

  it('does not mutate the input rows', () => {
    const row = flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001');
    const input = [row];
    gateByTrustLevel(input, 'cautious');
    expect(input).toHaveLength(1);
    expect(input[0]).toBe(row);
  });

  it('returns frozen arrays', () => {
    const row = flagFor(mkRow(), 'unknown-payee', 'PAYEE-UNK-001');
    const out = gateByTrustLevel([row], 'cautious');
    expect(Object.isFrozen(out.blocked)).toBe(true);
    expect(Object.isFrozen(out.skipped)).toBe(true);
    expect(Object.isFrozen(out.warned)).toBe(true);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('preserves input order within each bucket', () => {
    const rows = [
      mkRow({ importedId: 'a' }),
      flagFor(mkRow({ importedId: 'b' }), 'unknown-payee', 'PAYEE-UNK-001'),
      mkRow({ importedId: 'c' }),
      flagFor(mkRow({ importedId: 'd' }), 'duplicate', 'FITID-DUP-001'),
      mkRow({ importedId: 'e' }),
    ];
    const out = gateByTrustLevel(rows, 'cautious');
    expect(out.warned.map(r => r.importedId)).toEqual(['a', 'c', 'e']);
    expect(out.blocked.map(r => r.importedId)).toEqual(['b']);
    expect(out.skipped.map(r => r.importedId)).toEqual(['d']);
  });

  it('would-create-payee lands in warned at every trust level', () => {
    const row = flagFor(
      mkRow({ importedId: 't-new' }),
      'would-create-payee',
      'PAYEE-NEW-001',
    );
    for (const trust of ['paranoid', 'cautious', 'trusted'] as const) {
      const out = gateByTrustLevel([row], trust);
      expect(out.warned).toHaveLength(1);
      expect(out.blocked).toHaveLength(0);
      expect(out.skipped).toHaveLength(0);
    }
  });
});
