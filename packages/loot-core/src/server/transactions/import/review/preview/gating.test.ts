import type { Flag } from '#server/transactions/import/review/types';

import {
  effectiveFlags,
  evaluateRow,
  gateFromFlags,
  gateRow,
  isUsableDate,
  normalizePayeeName,
} from './gating';
import type { PreviewEdits, PreviewRow } from './preview-state';

function mkRow(
  overrides: Partial<PreviewRow> & { edits?: PreviewEdits } = {},
): PreviewRow {
  return {
    accountId: 'a-1',
    importedId: 't-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    payeeCanonical: '',
    payeeMatchSource: 'none',
    flags: [],
    decision: 'pending',
    edits: {},
    ...overrides,
  };
}

function flag(kind: PreviewRow['flags'][number]['kind']): Flag {
  const codes: Record<string, Flag['code']> = {
    'unknown-payee': 'PAYEE-UNK-001',
    'payee-rule-conflict': 'PAYEE-RULE-001',
    'amount-mismatch': 'AMT-MISMATCH-001',
    'date-out-of-range': 'DATE-RANGE-001',
    'needs-review': 'AMT-MISMATCH-001',
    duplicate: 'FITID-DUP-001',
    'fuzzy-payee-match': 'PAYEE-FUZZY-001',
    'would-create-payee': 'PAYEE-NEW-001',
    'transfer-detected': 'PAYEE-TRANSFER-001',
  };
  return { kind, code: codes[kind] };
}

describe('effectiveFlags', () => {
  it('keeps every flag when the user has edited nothing', () => {
    const row = mkRow({ flags: [flag('unknown-payee'), flag('duplicate')] });
    expect(effectiveFlags(row)).toEqual(row.flags);
  });

  it('clears unknown-payee once the user picked a payee', () => {
    const row = mkRow({
      flags: [flag('unknown-payee')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('does NOT clear unknown-payee for an empty payee name', () => {
    // An empty name is not a choice, it is the absence of one.
    const row = mkRow({
      flags: [flag('unknown-payee')],
      edits: { payeeCanonical: '   ' },
    });
    expect(effectiveFlags(row)).toHaveLength(1);
  });

  it('clears fuzzy-payee-match once the user picked a payee', () => {
    const row = mkRow({
      flags: [flag('fuzzy-payee-match')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('clears amount-mismatch once the user committed an amount', () => {
    const row = mkRow({
      flags: [flag('amount-mismatch')],
      edits: { amountCents: -2500 },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('keeps amount-mismatch when the user committed no amount', () => {
    const row = mkRow({ flags: [flag('amount-mismatch')] });
    expect(effectiveFlags(row)).toHaveLength(1);
  });

  it('clears date-out-of-range once the user committed a usable date', () => {
    const row = mkRow({
      flags: [flag('date-out-of-range')],
      edits: { date: '2026-09-09' },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('keeps date-out-of-range when the user committed an unusable date', () => {
    const row = mkRow({
      flags: [flag('date-out-of-range')],
      edits: { date: 'not-a-date' },
    });
    expect(effectiveFlags(row)).toHaveLength(1);
  });

  it('clears transfer-detected once the user confirmed the transfer', () => {
    const row = mkRow({
      flags: [flag('transfer-detected')],
      edits: { transferAccountId: 'a-2' },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('clears transfer-detected once the user replaced it with a payee', () => {
    const row = mkRow({
      flags: [flag('transfer-detected')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    expect(effectiveFlags(row)).toEqual([]);
  });

  it('clears would-create-payee once the user picked a payee that exists', () => {
    const row = mkRow({
      flags: [flag('would-create-payee')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    const opts = { livePayeeNames: new Set(['demo grocery store']) };
    expect(effectiveFlags(row, opts)).toEqual([]);
  });

  it('keeps would-create-payee when the payee the user picked is new', () => {
    // The import would still have to create it, so the flag is still true.
    const row = mkRow({
      flags: [flag('would-create-payee')],
      edits: { payeeCanonical: 'Demo Brand New Payee' },
    });
    const opts = { livePayeeNames: new Set(['demo grocery store']) };
    expect(effectiveFlags(row, opts)).toHaveLength(1);
  });

  it('keeps would-create-payee when the live payees are unknown', () => {
    const row = mkRow({
      flags: [flag('would-create-payee')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    expect(effectiveFlags(row)).toHaveLength(1);
  });

  it('never clears a duplicate', () => {
    // A repeated FITID is a property of the file, not of the row's edits.
    const row = mkRow({
      flags: [flag('duplicate')],
      edits: {
        payeeCanonical: 'Demo Grocery Store',
        amountCents: -2500,
        date: '2026-09-09',
      },
    });
    expect(effectiveFlags(row)).toHaveLength(1);
  });

  it('does not mutate the row', () => {
    const row = mkRow({ flags: [flag('unknown-payee')] });
    effectiveFlags(row, { livePayeeNames: new Set(['demo vendor']) });
    expect(row.flags).toHaveLength(1);
  });
});

describe('gateFromFlags', () => {
  it('is allow for no flags at all', () => {
    expect(gateFromFlags([], 'paranoid')).toBe('allow');
  });

  it('takes the worst outcome among several flags', () => {
    expect(
      gateFromFlags([flag('fuzzy-payee-match'), flag('duplicate')], 'cautious'),
    ).toBe('skip');
    expect(
      gateFromFlags([flag('fuzzy-payee-match'), flag('duplicate')], 'paranoid'),
    ).toBe('block');
  });

  it('ranks block over skip over warn', () => {
    expect(gateFromFlags([flag('duplicate')], 'cautious')).toBe('skip');
    expect(gateFromFlags([flag('would-create-payee')], 'cautious')).toBe(
      'warn',
    );
  });
});

describe('gateRow', () => {
  it('allows a row with no flags', () => {
    expect(gateRow(mkRow(), 'paranoid')).toBe('allow');
  });

  it('blocks an unknown payee at cautious', () => {
    const row = mkRow({ flags: [flag('unknown-payee')] });
    expect(gateRow(row, 'cautious')).toBe('block');
  });

  it('only warns about an unknown payee at trusted', () => {
    const row = mkRow({ flags: [flag('unknown-payee')] });
    expect(gateRow(row, 'trusted')).toBe('warn');
  });

  it('blocks a broken date at every trust level', () => {
    const row = mkRow({ flags: [flag('date-out-of-range')] });
    expect(gateRow(row, 'paranoid')).toBe('block');
    expect(gateRow(row, 'cautious')).toBe('block');
    expect(gateRow(row, 'trusted')).toBe('block');
  });

  it('releases a row the user fixed', () => {
    const row = mkRow({
      flags: [flag('unknown-payee')],
      edits: { payeeCanonical: 'Demo Grocery Store' },
    });
    expect(gateRow(row, 'cautious')).toBe('allow');
  });
});

describe('override eligibility', () => {
  it('is false for a hard-blocked row', () => {
    const row = mkRow({ flags: [flag('date-out-of-range')] });
    expect(evaluateRow(row, 'cautious').overridable).toBe(false);
  });

  it('is true for a soft-blocked row', () => {
    const row = mkRow({ flags: [flag('unknown-payee')] });
    expect(evaluateRow(row, 'cautious').overridable).toBe(true);
  });

  it('is true for a clean row', () => {
    expect(evaluateRow(mkRow(), 'cautious').overridable).toBe(true);
  });

  it('becomes true once the user fixes a hard block', () => {
    const row = mkRow({
      flags: [flag('date-out-of-range')],
      edits: { date: '2026-09-09' },
    });
    expect(evaluateRow(row, 'cautious').overridable).toBe(true);
  });
});

describe('evaluateRow', () => {
  it('lets a clean pending row through', () => {
    const evaluation = evaluateRow(mkRow(), 'cautious');
    expect(evaluation.gate).toBe('allow');
    expect(evaluation.held).toBe(false);
    expect(evaluation.willImport).toBe(true);
    expect(evaluation.overridable).toBe(true);
  });

  it('holds back a blocked pending row', () => {
    const evaluation = evaluateRow(
      mkRow({ flags: [flag('unknown-payee')] }),
      'cautious',
    );
    expect(evaluation.gate).toBe('block');
    expect(evaluation.held).toBe(true);
    expect(evaluation.willImport).toBe(false);
  });

  it('holds back a blocked row the user merely accepted', () => {
    // The gate holds over a plain accept. The row is released again if the
    // trust level is lowered.
    const evaluation = evaluateRow(
      mkRow({ flags: [flag('unknown-payee')], decision: 'accept' }),
      'cautious',
    );
    expect(evaluation.held).toBe(true);
    expect(evaluation.willImport).toBe(false);
  });

  it('releases a blocked row the user overrode', () => {
    const evaluation = evaluateRow(
      mkRow({
        flags: [flag('unknown-payee')],
        decision: 'accept-override',
      }),
      'cautious',
    );
    expect(evaluation.held).toBe(false);
    expect(evaluation.willImport).toBe(true);
    expect(evaluation.overridden).toBe(true);
  });

  it('does NOT release a hard-blocked row, even when overridden', () => {
    const evaluation = evaluateRow(
      mkRow({
        flags: [flag('date-out-of-range')],
        decision: 'accept-override',
      }),
      'cautious',
    );
    expect(evaluation.held).toBe(true);
    expect(evaluation.willImport).toBe(false);
    expect(evaluation.overridable).toBe(false);
  });

  it('drops a row the user threw away', () => {
    const evaluation = evaluateRow(
      mkRow({ flags: [flag('unknown-payee')], decision: 'drop' }),
      'cautious',
    );
    expect(evaluation.held).toBe(false);
    expect(evaluation.willImport).toBe(false);
  });

  it('lets a warned row through', () => {
    const evaluation = evaluateRow(
      mkRow({ flags: [flag('would-create-payee')] }),
      'cautious',
    );
    expect(evaluation.gate).toBe('warn');
    expect(evaluation.held).toBe(false);
    expect(evaluation.willImport).toBe(true);
  });
});

describe('normalizePayeeName', () => {
  it('trims and lowercases', () => {
    expect(normalizePayeeName('  Demo Grocery Store ')).toBe(
      'demo grocery store',
    );
  });
});

describe('isUsableDate', () => {
  it('accepts a plain date', () => {
    expect(isUsableDate('2026-09-07')).toBe(true);
  });

  it('rejects a missing or malformed date', () => {
    expect(isUsableDate(undefined)).toBe(false);
    expect(isUsableDate('')).toBe(false);
    expect(isUsableDate('2026-9-7')).toBe(false);
    expect(isUsableDate('Invalid Date')).toBe(false);
  });

  it('rejects a date that is shaped like one but is not', () => {
    // The shape is not enough: this is the only thing that releases the
    // `date-out-of-range` hard block, so an impossible date would let
    // broken data through.
    expect(isUsableDate('2026-13-01')).toBe(false);
    expect(isUsableDate('2026-00-10')).toBe(false);
    expect(isUsableDate('2026-02-31')).toBe(false);
    expect(isUsableDate('2026-04-31')).toBe(false);
  });

  it('accepts a leap day in a leap year, and rejects it otherwise', () => {
    expect(isUsableDate('2024-02-29')).toBe(true);
    expect(isUsableDate('2026-02-29')).toBe(false);
  });
});
