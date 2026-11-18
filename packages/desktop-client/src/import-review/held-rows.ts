import type { RowEvaluation } from '@actual-app/core/server/transactions/import/review/index';

/**
 * Whether any row is held back that the user can override.
 *
 * The answer is NOT "is a row blocked", for two reasons, and both of
 * them are wrong answers:
 *
 * - A hard-blocked row — an amount mismatch, a date out of range — is
 *   held back but **cannot** be overridden. Only fixing it clears the
 *   flag, so offering the override would offer a key that refuses.
 * - A **skipped** row — a duplicate FITID at the cautious trust level —
 *   is held back and CAN be overridden, but it is not counted as
 *   "blocked" at all. Asking the summary would miss exactly the case
 *   where the user most needs to know about the override.
 *
 * So the question is asked of the evaluation, which knows both things.
 */
export function hasOverridableHeldRow(
  evaluations: ReadonlyMap<string, RowEvaluation>,
): boolean {
  for (const evaluation of evaluations.values()) {
    if (isOverridableHeld(evaluation)) return true;
  }
  return false;
}

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
