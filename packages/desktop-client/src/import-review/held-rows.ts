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
    if (evaluation.held && evaluation.overridable) return true;
  }
  return false;
}
