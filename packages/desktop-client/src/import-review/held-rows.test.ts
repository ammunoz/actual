import type { RowEvaluation } from '@actual-app/core/server/transactions/import/review/index';

import { isOverridableHeld } from './held-rows';

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

describe('isOverridableHeld', () => {
  it('is false for a clean row, even though it is overridable', () => {
    expect(
      isOverridableHeld(evaluation({ held: false, overridable: true })),
    ).toBe(false);
  });

  it('is true for a held row the user can override', () => {
    // A duplicate FITID at the cautious trust level: skipped, held,
    // and overridable. This is the case a "blocked" count misses.
    expect(
      isOverridableHeld(
        evaluation({ gate: 'skip', held: true, overridable: true }),
      ),
    ).toBe(true);
  });

  it('is false for a held row the user CANNOT override', () => {
    // An amount mismatch is a hard block: only fixing it clears the
    // flag, so offering the override would offer a key that refuses.
    expect(
      isOverridableHeld(
        evaluation({ gate: 'block', held: true, overridable: false }),
      ),
    ).toBe(false);
  });

  it('is false for a row the user dropped', () => {
    expect(
      isOverridableHeld(evaluation({ held: false, overridable: true })),
    ).toBe(false);
  });
});
