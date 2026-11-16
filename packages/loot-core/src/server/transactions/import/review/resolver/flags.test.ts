import type {
  Flag,
  FlagKind,
  ResolvedRow,
  ReviewRowInput,
  TrustLevel,
} from '#server/transactions/import/review/types';

import { flagDuplicateFitids, flagFor, isHardBlock, outcomeFor } from './flags';

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
    const out = flagFor(row, 'unknown-payee', 'PAYEE-UNK-001', 'r-a|r-b');
    expect(out.flags).toEqual([
      { kind: 'unknown-payee', code: 'PAYEE-UNK-001', note: 'r-a|r-b' },
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
    'amount-mismatch',
    'date-out-of-range',
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
    // The two hard blocks: broken data is blocked at every trust level.
    'amount-mismatch': {
      paranoid: 'block',
      cautious: 'block',
      trusted: 'block',
    },
    'date-out-of-range': {
      paranoid: 'block',
      cautious: 'block',
      trusted: 'block',
    },
    duplicate: { paranoid: 'block', cautious: 'skip', trusted: 'warn' },
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

describe('isHardBlock', () => {
  it('treats the two data-level kinds as hard blocks', () => {
    // A row whose date or amount the file did not supply cannot be
    // imported correctly at any trust level, so it cannot be overridden.
    expect(isHardBlock('amount-mismatch')).toBe(true);
    expect(isHardBlock('date-out-of-range')).toBe(true);
  });

  it('does not treat a judgement flag as a hard block', () => {
    expect(isHardBlock('unknown-payee')).toBe(false);
    expect(isHardBlock('duplicate')).toBe(false);
    expect(isHardBlock('fuzzy-payee-match')).toBe(false);
    expect(isHardBlock('would-create-payee')).toBe(false);
    expect(isHardBlock('transfer-detected')).toBe(false);
  });
});

describe('flagDuplicateFitids', () => {
  function mkInput(importedId?: string): ReviewRowInput & {
    flags?: readonly Flag[];
  } {
    return {
      accountId: 'a-1',
      importedId,
      date: '2026-09-07',
      amountCents: -2500,
      payeeRaw: 'Demo Vendor',
    };
  }

  it('leaves a file with no repeats alone', () => {
    const rows = [mkInput('FITID-1'), mkInput('FITID-2')];
    const out = flagDuplicateFitids(rows);
    expect(out.every(r => r.flags === undefined)).toBe(true);
  });

  it('flags the repeat, not the first occurrence', () => {
    // The first row is the one that describes the transaction; the repeat
    // is the one that would be imported on top of it.
    const out = flagDuplicateFitids([mkInput('FITID-1'), mkInput('FITID-1')]);
    expect(out[0].flags).toBeUndefined();
    expect(out[1].flags).toEqual([
      { kind: 'duplicate', code: 'FITID-DUP-001' },
    ]);
  });

  it('flags every repeat after the first', () => {
    const out = flagDuplicateFitids([
      mkInput('FITID-1'),
      mkInput('FITID-1'),
      mkInput('FITID-1'),
    ]);
    expect(out[0].flags).toBeUndefined();
    expect(out[1].flags).toHaveLength(1);
    expect(out[2].flags).toHaveLength(1);
  });

  it('never flags a row with no FITID', () => {
    // There is nothing to repeat.
    const out = flagDuplicateFitids([mkInput(undefined), mkInput(undefined)]);
    expect(out.every(r => r.flags === undefined)).toBe(true);
  });

  it('keeps the flags the row already had', () => {
    const row = {
      ...mkInput('FITID-1'),
      flags: [
        { kind: 'unknown-payee' as const, code: 'PAYEE-UNK-001' as const },
      ],
    };
    const out = flagDuplicateFitids([mkInput('FITID-1'), row]);
    expect(out[1].flags).toEqual([
      { kind: 'unknown-payee', code: 'PAYEE-UNK-001' },
      { kind: 'duplicate', code: 'FITID-DUP-001' },
    ]);
  });

  it('does not mutate the input rows', () => {
    const rows = [mkInput('FITID-1'), mkInput('FITID-1')];
    flagDuplicateFitids(rows);
    expect(rows[1].flags).toBeUndefined();
  });
});
