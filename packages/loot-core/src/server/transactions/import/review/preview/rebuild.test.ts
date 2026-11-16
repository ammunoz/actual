import { describe, expect, it } from 'vitest';

import type { ReviewRowInput } from '#server/transactions/import/review/types';

import { buildPreviewState } from './preview-state';
import { rebuildPreviewState } from './rebuild';

/**
 * A re-resolution can happen while the review is open — the vendor map is
 * a synced preference and can arrive late or change under the review.
 *
 * What a re-resolution must never do is throw away the user's work: the
 * decision they made and the edits they typed are theirs, and they are
 * carried across by the row's key.
 */
function row(overrides: Partial<ReviewRowInput> = {}): ReviewRowInput {
  return {
    accountId: 'a-checking',
    importedId: 'FITID-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Grocery Store',
    previewKey: 'row-0',
    ...overrides,
  };
}

const PAYEES = [{ id: 'p-1', name: 'Demo Grocery Store' }];
const ACCOUNTS = [
  { id: 'a-checking', name: 'Demo Checking' },
  { id: 'a-savings', name: 'Demo Savings' },
];

function resolveOpts() {
  return { existingPayees: PAYEES, accounts: ACCOUNTS };
}

describe('rebuildPreviewState', () => {
  it('keeps the account every row is imported into', () => {
    const base = [row(), row({ previewKey: 'row-1' })];

    const next = rebuildPreviewState({
      base,
      previous: buildPreviewState([], 'cautious'),
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });

    expect(next.rows.map(r => r.accountId)).toEqual([
      'a-checking',
      'a-checking',
    ]);
  });

  it('keeps the decisions and the edits', () => {
    const base = [row(), row({ previewKey: 'row-1' })];
    const started = buildPreviewState(
      [
        {
          ...row(),
          payeeCanonical: 'Demo Grocery Store',
          payeeMatchSource: 'existing-prefix',
          flags: [],
        },
        {
          ...row({ previewKey: 'row-1' }),
          payeeCanonical: 'Demo Vendor',
          payeeMatchSource: 'existing-prefix',
          flags: [],
        },
      ],
      'cautious',
    );

    const next = rebuildPreviewState({
      base,
      previous: {
        ...started,
        rows: started.rows.map((r, index) =>
          index === 0
            ? { ...r, decision: 'accept' as const, edits: { memo: 'a note' } }
            : { ...r, decision: 'drop' as const, edits: {} },
        ),
      },
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });

    expect(next.rows[0].decision).toBe('accept');
    expect(next.rows[0].edits.memo).toBe('a note');
    expect(next.rows[1].decision).toBe('drop');
  });

  it('carries the work across by key, not by position', () => {
    // The rows are reordered between the two states. The work belongs to
    // the row with the key, so it lands on that row and not on the row
    // that happens to be first.
    const base = [row({ previewKey: 'row-0' }), row({ previewKey: 'row-1' })];
    const started = buildPreviewState(
      [
        {
          ...row({ previewKey: 'row-0' }),
          payeeCanonical: 'A',
          payeeMatchSource: 'none',
          flags: [],
        },
        {
          ...row({ previewKey: 'row-1' }),
          payeeCanonical: 'B',
          payeeMatchSource: 'none',
          flags: [],
        },
      ],
      'cautious',
    );

    const next = rebuildPreviewState({
      base,
      previous: {
        ...started,
        rows: [
          { ...started.rows[1], decision: 'accept' as const },
          { ...started.rows[0], decision: 'drop' as const },
        ],
      },
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });

    expect(next.rows[0].decision).toBe('drop');
    expect(next.rows[1].decision).toBe('accept');
  });

  it('makes a row a transfer only when the account is not its own', () => {
    // The vendor string is exactly an account's name, so the row looks
    // like a transfer to it — unless the row is IN that account.
    const inSavings = rebuildPreviewState({
      base: [row({ payeeRaw: 'Demo Savings', accountId: 'a-savings' })],
      previous: buildPreviewState([], 'cautious'),
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });
    expect(inSavings.rows[0].matchedTransferAccountId).toBeUndefined();

    const inChecking = rebuildPreviewState({
      base: [row({ payeeRaw: 'Demo Savings' })],
      previous: buildPreviewState([], 'cautious'),
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });
    expect(inChecking.rows[0].matchedTransferAccountId).toBe('a-savings');
  });

  it('resolves the rows again rather than reusing the old resolution', () => {
    // The row is resolved against the payee list every time, so a
    // rebuild is not a copy of the old state.
    const base = [row()];
    const next = rebuildPreviewState({
      base,
      previous: buildPreviewState([], 'cautious'),
      trustLevel: 'cautious',
      resolveOpts: resolveOpts(),
    });

    expect(next.rows[0].payeeCanonical).toBe('Demo Grocery Store');
    expect(next.rows[0].payeeMatchSource).toBe('existing-prefix');
  });
});
