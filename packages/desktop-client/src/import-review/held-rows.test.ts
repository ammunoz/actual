import type { RowEvaluation } from '@actual-app/core/server/transactions/import/review/index';

import { hasOverridableHeldRow } from './held-rows';

function evaluation(overrides: Partial<RowEvaluation>): RowEvaluation {
  return {
    gate: 'allow',
    held: false,
    willImport: true,
    willSend: true,
    overridable: true,
    overridden: false,
    flags: [],
    ...overrides,
  };
}

function evaluations(
  ...rows: RowEvaluation[]
): ReadonlyMap<string, RowEvaluation> {
  return new Map(rows.map((row, index) => [String(index), row]));
}

/**
 * Whether the hint strip should say the override.
 *
 * The answer decides whether the strip advertises `Ctrl+Shift+A` — the
 * only key that releases a held row.
 */
describe('hasOverridableHeldRow', () => {
  it('is false when nothing is held', () => {
    expect(hasOverridableHeldRow(evaluations())).toBe(false);
    expect(
      hasOverridableHeldRow(
        evaluations(evaluation({ held: false, overridable: true })),
      ),
    ).toBe(false);
  });

  it('is true for a held row the user can override', () => {
    // A duplicate FITID at the cautious trust level: skipped, held,
    // and overridable. This is the case the summary's "blocked" count
    // misses.
    expect(
      hasOverridableHeldRow(
        evaluations(
          evaluation({ gate: 'skip', held: true, overridable: true }),
        ),
      ),
    ).toBe(true);
  });

  it('is false for a held row the user CANNOT override', () => {
    // An amount mismatch is a hard block: only fixing it clears the
    // flag, so offering the override would offer a key that refuses.
    expect(
      hasOverridableHeldRow(
        evaluations(
          evaluation({ gate: 'block', held: true, overridable: false }),
        ),
      ),
    ).toBe(false);
  });

  it('is false for a row the user dropped', () => {
    // A dropped row is not "held": the user threw it away, which is
    // a stronger statement than the gate.
    expect(
      hasOverridableHeldRow(
        evaluations(evaluation({ held: false, overridable: true })),
      ),
    ).toBe(false);
  });

  it('is true when ONE of several rows can be overridden', () => {
    expect(
      hasOverridableHeldRow(
        evaluations(
          evaluation({ gate: 'allow', held: false }),
          evaluation({ gate: 'block', held: true, overridable: false }),
          evaluation({ gate: 'skip', held: true, overridable: true }),
        ),
      ),
    ).toBe(true);
  });
});
