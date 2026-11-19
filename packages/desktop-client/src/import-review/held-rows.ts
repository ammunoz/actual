import type { RowEvaluation } from '@actual-app/core/server/transactions/import/review/index';

/**
 * Whether a row is held back that the user can override.
 *
 * Both halves are needed, and neither alone says it:
 *
 * - `overridable` on its own is not enough: it says the row is not
 *   hard-blocked, which is true of almost every row — a clean row
 *   would offer an override of nothing.
 * - `held` on its own is not enough: a hard-blocked row is held back
 *   but CANNOT be overridden. Only fixing it clears the flag, so
 *   offering the override would offer a key that refuses.
 */
export function isOverridableHeld(evaluation: RowEvaluation): boolean {
  return evaluation.held && evaluation.overridable;
}
