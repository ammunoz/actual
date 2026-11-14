import type {
  ResolvedRow,
  TrustLevel,
} from '#server/transactions/import/review/types';

import {
  applyDecision,
  buildPreviewState,
  effectiveAmountCents,
  effectiveTransferAccountId,
  isSplitRow,
  PREVIEW_STATE_NOT_FOUND,
  PreviewStateError,
  rowKey,
  summarize,
  updateEdits,
  withTrustLevel,
} from './preview-state';

function mkRow(overrides: Partial<ResolvedRow> = {}): ResolvedRow {
  return {
    accountId: 'a-1',
    importedId: 't-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    payeeCanonical: 'Demo Vendor',
    payeeMatchSource: 'strip-fallback',
    flags: [],
    ...overrides,
  };
}

describe('buildPreviewState', () => {
  it('starts every row as pending with empty edits', () => {
    const state = buildPreviewState(
      [mkRow(), mkRow({ importedId: 't-2' })],
      'cautious',
    );
    expect(state.rows).toHaveLength(2);
    expect(state.rows.every(r => r.decision === 'pending')).toBe(true);
    expect(state.rows.every(r => Object.keys(r.edits).length === 0)).toBe(true);
  });

  it('preserves the trust level', () => {
    expect(buildPreviewState([], 'paranoid').trustLevel).toBe('paranoid');
  });

  it('does not mutate the input rows', () => {
    const rows = [mkRow()];
    buildPreviewState(rows, 'cautious');
    expect(rows[0]).not.toHaveProperty('decision');
  });
});

describe('rowKey', () => {
  it('prefers the previewKey', () => {
    // The FITID is not unique — some files omit it and a malformed file can
    // repeat one — so it cannot identify a row inside the review.
    expect(rowKey(mkRow({ importedId: 'fit-1', previewKey: 'k-1' }))).toBe(
      'k-1',
    );
  });

  it('falls back to importedId when there is no previewKey', () => {
    expect(rowKey(mkRow({ importedId: 'fit-1', previewKey: undefined }))).toBe(
      'fit-1',
    );
  });

  it('gives two rows with the same FITID different keys', () => {
    const state = buildPreviewState(
      [
        mkRow({ importedId: 'same', previewKey: 'k-1' }),
        mkRow({ importedId: 'same', previewKey: 'k-2' }),
      ],
      'cautious',
    );
    expect(new Set(state.rows.map(rowKey)).size).toBe(2);
  });

  it('returns an empty string when neither is present', () => {
    expect(
      rowKey(mkRow({ importedId: undefined, previewKey: undefined })),
    ).toBe('');
  });
});

describe('applyDecision', () => {
  it('sets the decision on the matching row', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const next = applyDecision(state, 't-1', 'accept');
    expect(next.rows[0].decision).toBe('accept');
  });

  it('leaves other rows untouched', () => {
    const state = buildPreviewState(
      [mkRow({ importedId: 't-1' }), mkRow({ importedId: 't-2' })],
      'cautious',
    );
    const next = applyDecision(state, 't-1', 'accept');
    expect(next.rows[1].decision).toBe('pending');
  });

  it('replaces edits wholesale (no merge)', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const withEdits = updateEdits(state, 't-1', { memo: 'first' });
    const next = applyDecision(withEdits, 't-1', 'accept', {
      categoryId: 'c-1',
    });
    expect(next.rows[0].edits.memo).toBeUndefined();
    expect(next.rows[0].edits.categoryId).toBe('c-1');
  });

  it('keeps the previous edits when no edits argument is given', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const withEdits = updateEdits(state, 't-1', { memo: 'kept' });
    const next = applyDecision(withEdits, 't-1', 'accept');
    expect(next.rows[0].edits.memo).toBe('kept');
  });

  it('throws PREVIEW-STATE-001 for an empty key', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    expect(() => applyDecision(state, '', 'accept')).toThrow(PreviewStateError);
    try {
      applyDecision(state, '', 'accept');
    } catch (err) {
      expect((err as PreviewStateError).code).toBe(PREVIEW_STATE_NOT_FOUND);
    }
  });

  it('throws PREVIEW-STATE-001 when the row is not found', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    expect(() => applyDecision(state, 'nope', 'accept')).toThrow(
      PreviewStateError,
    );
  });

  it('does not mutate the input state', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    applyDecision(state, 't-1', 'accept');
    expect(state.rows[0].decision).toBe('pending');
  });
});

describe('updateEdits', () => {
  it('preserves the decision', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const accepted = applyDecision(state, 't-1', 'accept');
    const next = updateEdits(accepted, 't-1', { memo: 'edited' });
    expect(next.rows[0].decision).toBe('accept');
    expect(next.rows[0].edits.memo).toBe('edited');
  });

  it('does not flip a pending row to accept', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const next = updateEdits(state, 't-1', { memo: 'edited' });
    expect(next.rows[0].decision).toBe('pending');
  });

  it('preserves the other row fields', () => {
    const state = buildPreviewState(
      [mkRow({ matchedPayeeId: 'p-1' })],
      'cautious',
    );
    const next = updateEdits(state, 't-1', { memo: 'edited' });
    expect(next.rows[0].matchedPayeeId).toBe('p-1');
    expect(next.rows[0].payeeMatchSource).toBe('strip-fallback');
  });

  it('deep-freezes the split legs so the committed state cannot be mutated', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const next = updateEdits(state, 't-1', {
      splits: [{ amountCents: -1500, categoryId: 'c-1' }],
    });
    expect(Object.isFrozen(next.rows[0].edits.splits)).toBe(true);
    expect(Object.isFrozen(next.rows[0].edits.splits?.[0])).toBe(true);
  });

  it('throws when the row is not found', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    expect(() => updateEdits(state, 'nope', {})).toThrow(PreviewStateError);
  });
});

describe('a decision only touches one row', () => {
  it('does not fan out when two rows share a key', () => {
    // The key has to identify exactly one row. If it ever did not, a single
    // decision would apply to several rows at once.
    const state = buildPreviewState(
      [
        mkRow({ importedId: 'same', previewKey: 'k-1' }),
        mkRow({ importedId: 'same', previewKey: 'k-1' }),
      ],
      'cautious',
    );
    const next = applyDecision(state, 'k-1', 'accept');
    const accepted = next.rows.filter(r => r.decision === 'accept');
    expect(accepted).toHaveLength(1);
  });
});

describe('withTrustLevel', () => {
  it('changes the trust level without touching the rows', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const next = withTrustLevel(state, 'paranoid');
    expect(next.trustLevel).toBe('paranoid');
    expect(next.rows).toBe(state.rows);
  });

  it('returns the same state when the level is unchanged', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    expect(withTrustLevel(state, 'cautious')).toBe(state);
  });

  it('keeps the decisions when the level changes', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    const accepted = applyDecision(state, rowKey(state.rows[0]), 'accept');
    const next = withTrustLevel(accepted, 'paranoid');
    expect(next.rows[0].decision).toBe('accept');
  });
});

describe('effectiveAmountCents', () => {
  it('uses the bank value when there is no edit', () => {
    const state = buildPreviewState(
      [mkRow({ amountCents: -2500 })],
      'cautious',
    );
    expect(effectiveAmountCents(state.rows[0])).toBe(-2500);
  });

  it('prefers the user edit', () => {
    const state = buildPreviewState(
      [mkRow({ amountCents: -2500 })],
      'cautious',
    );
    const next = updateEdits(state, 't-1', { amountCents: -3000 });
    expect(effectiveAmountCents(next.rows[0])).toBe(-3000);
  });
});

describe('effectiveTransferAccountId', () => {
  it('falls back to the resolver auto-detect', () => {
    const state = buildPreviewState(
      [mkRow({ matchedTransferAccountId: 'a-2' })],
      'cautious',
    );
    expect(effectiveTransferAccountId(state.rows[0])).toBe('a-2');
  });

  it('prefers the user choice over the auto-detect', () => {
    const state = buildPreviewState(
      [mkRow({ matchedTransferAccountId: 'a-2' })],
      'cautious',
    );
    const next = updateEdits(state, 't-1', { transferAccountId: 'a-3' });
    expect(effectiveTransferAccountId(next.rows[0])).toBe('a-3');
  });

  it('is undefined for an ordinary row', () => {
    const state = buildPreviewState([mkRow()], 'cautious');
    expect(effectiveTransferAccountId(state.rows[0])).toBeUndefined();
  });
});

describe('isSplitRow', () => {
  it('is true when splits are present', () => {
    expect(isSplitRow({ splits: [{ amountCents: -100 }] })).toBe(true);
  });

  it('is false when splits are absent', () => {
    expect(isSplitRow({})).toBe(false);
  });

  it('does not treat a transfer as a split', () => {
    expect(isSplitRow({ transferAccountId: 'a-1' })).toBe(false);
  });
});

describe('summarize', () => {
  it('counts decisions across all rows', () => {
    const state = buildPreviewState(
      [
        mkRow({ importedId: 't-1' }),
        mkRow({ importedId: 't-2' }),
        mkRow({ importedId: 't-3' }),
      ],
      'cautious',
    );
    const accepted = applyDecision(state, 't-1', 'accept');
    const dropped = applyDecision(accepted, 't-2', 'drop');
    const summary = summarize(dropped);
    expect(summary.total).toBe(3);
    expect(summary.accepted).toBe(1);
    expect(summary.dropped).toBe(1);
    expect(summary.pending).toBe(1);
  });

  it('excludes dropped rows from the inflow/outflow split', () => {
    const state = buildPreviewState(
      [
        mkRow({ importedId: 't-1', amountCents: 5000 }),
        mkRow({ importedId: 't-2', amountCents: -2500 }),
      ],
      'cautious',
    );
    const dropped = applyDecision(state, 't-1', 'drop');
    const summary = summarize(dropped);
    expect(summary.inflowCount).toBe(0);
    expect(summary.outflowCount).toBe(1);
  });

  it('derives the direction from the effective amount sign, not a stored field', () => {
    const state = buildPreviewState(
      [mkRow({ importedId: 't-1', amountCents: -2500 })],
      'cautious',
    );
    const flipped = updateEdits(state, 't-1', { amountCents: 2500 });
    const summary = summarize(flipped);
    expect(summary.inflowCount).toBe(1);
    expect(summary.outflowCount).toBe(0);
  });

  it('counts a zero amount as neither inflow nor outflow', () => {
    const state = buildPreviewState(
      [mkRow({ importedId: 't-1', amountCents: 0 })],
      'cautious',
    );
    const summary = summarize(state);
    expect(summary.inflowCount).toBe(0);
    expect(summary.outflowCount).toBe(0);
  });

  it('buckets rows by trust level', () => {
    const blocked = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'paranoid',
    );
    const summary = summarize(blocked);
    expect(summary.blocked).toBe(1);
    expect(summary.warned).toBe(0);
  });

  it('an accepted row still counts toward its flag bucket', () => {
    const state = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'paranoid',
    );
    const accepted = applyDecision(state, 't-1', 'accept');
    const summary = summarize(accepted);
    expect(summary.accepted).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it('does not count a dropped row as held back', () => {
    // The user threw the row away, which is a stronger statement than the
    // gate.
    const state = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'cautious',
    );
    const dropped = applyDecision(state, 't-1', 'drop');
    const summary = summarize(dropped);
    expect(summary.blocked).toBe(0);
    expect(summary.dropped).toBe(1);
  });

  it('releases a held-back row the user overrode', () => {
    const state = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'cautious',
    );
    const overridden = applyDecision(state, 't-1', 'accept-override');
    const summary = summarize(overridden);
    expect(summary.blocked).toBe(0);
    expect(summary.overridden).toBe(1);
    expect(summary.accepted).toBe(1);
  });

  it('counts an overridden row as accepted as well as overridden', () => {
    const state = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'cautious',
    );
    const overridden = applyDecision(state, 't-1', 'accept-override');
    const summary = summarize(overridden);
    expect(summary.accepted).toBe(1);
    expect(summary.overridden).toBe(1);
    expect(summary.pending).toBe(0);
  });

  it('excludes a held-back row from the inflow/outflow split', () => {
    // The split describes what will reach the budget, so a row the gate
    // holds back is not counted.
    const state = buildPreviewState(
      [
        mkRow({
          importedId: 't-1',
          amountCents: -2500,
          flags: [{ kind: 'unknown-payee', code: 'PAYEE-UNK-001' }],
        }),
      ],
      'cautious',
    );
    const summary = summarize(state);
    expect(summary.blocked).toBe(1);
    expect(summary.outflowCount).toBe(0);
  });

  it('does not warn about a row with no flags at all', () => {
    const state = buildPreviewState([mkRow({ importedId: 't-1' })], 'cautious');
    const summary = summarize(state);
    expect(summary.warned).toBe(0);
    expect(summary.blocked).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('returns zeroed counts for an empty state', () => {
    const summary = summarize(buildPreviewState([], 'cautious'));
    expect(summary.total).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(summary.pending).toBe(0);
  });
});

describe('trust level propagation', () => {
  const levels: readonly TrustLevel[] = ['paranoid', 'cautious', 'trusted'];

  it('survives a decision cycle', () => {
    for (const level of levels) {
      const state = buildPreviewState([mkRow()], level);
      const next = applyDecision(state, 't-1', 'accept');
      expect(next.trustLevel).toBe(level);
    }
  });
});
