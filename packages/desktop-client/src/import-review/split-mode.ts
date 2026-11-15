/**
 * The split editor's pure parts.
 *
 * The split pane is deliberately dumb: it holds a draft of legs and hands
 * them over. Everything that can be decided without a DOM is decided
 * here, so it can be tested without one:
 *
 *   - what is left of the row's amount, and which way the legs are off,
 *   - how the remainder is spread when the user asks for it,
 *   - what a leg's amount field starts out showing.
 *
 * The leg algebra itself is NOT here: `split-primitives.ts` in the domain
 * owns it, and the pane drives the same functions, so the review and the
 * apply step cannot disagree about what a balanced split is.
 */

import {
  replaceLeg,
  splitResidualCents,
  splitResidualDirection,
  splitTotalCents,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  PreviewSplitLeg,
  SplitResidualDirection,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';

/**
 * What is left of the row's amount, and which way the legs are off.
 *
 * The two are separate because the residual's SIGN does not say which
 * way the legs are off: on a debit row, a positive residual is an
 * overshoot and a negative one is a shortfall. The domain derives the
 * direction from the leg total and the target instead.
 */
export type SplitResidual = {
  /**
   * The amount a NEW leg would have to carry to close the gap, in cents.
   *
   * Zero means the split balances. The value is signed the way the row is
   * signed, so it is directly usable as a leg amount.
   */
  cents: number;
  /** Which way the legs are off. */
  direction: SplitResidualDirection;
};

/**
 * Pure: what is left of the row's amount.
 */
export function splitResidual(
  legs: readonly PreviewSplitLeg[],
  targetCents: number,
): SplitResidual {
  return {
    cents: splitResidualCents(legs, targetCents),
    direction: splitResidualDirection(legs, targetCents),
  };
}

/**
 * Pure: the text a leg's amount field starts out showing.
 *
 * The field starts out showing the amount the leg carries, so the user
 * edits what they see rather than retyping it.
 */
export function legAmountText(cents: number): string {
  return integerToAmount(cents).toFixed(2);
}

/**
 * Pure: spread `amountCents` evenly over the legs at `indexes`.
 *
 * The share is FLOORED, and the cents that do not divide are handed to
 * the earliest of the legs one each. So the legs sum to `amountCents`
 * exactly, and the LAST leg keeps the floored share.
 *
 * This is the rule Actual's own "Distribute" button uses.
 */
function spreadEvenly(
  legs: readonly PreviewSplitLeg[],
  indexes: readonly number[],
  amountCents: number,
): readonly PreviewSplitLeg[] {
  const share = Math.floor(amountCents / indexes.length);
  let leftover = amountCents - share * indexes.length;

  let out = legs;
  indexes.forEach(legIndex => {
    let cents = share;
    if (leftover !== 0) {
      cents += 1;
      leftover -= 1;
    }
    out = replaceLeg(out, legIndex, {
      ...legs[legIndex],
      amountCents: cents,
    });
  });
  return out;
}

/**
 * Pure: the legs that result from spreading the remainder over the split.
 *
 * This mirrors what Actual's own transactions table does with its
 * "Distribute" button, so a user who has used it there is not surprised
 * here:
 *
 *   - The EMPTY legs take the remainder, evenly. An empty leg is one the
 *     user has not given an amount to, so it is the one that is missing
 *     money.
 *   - With no empty leg, the remainder is spread over the legs in
 *     PROPORTION to what they already carry.
 *
 * The result always sums to the target exactly. In the proportional
 * branch the cents lost in the rounding are handed to the legs that
 * lost the most in the rounding, so the split balances rather than
 * being "close to" balanced.
 *
 * The legs themselves are not mutated: a new frozen array comes back.
 */
export function distributeResidual(
  legs: readonly PreviewSplitLeg[],
  targetCents: number,
): readonly PreviewSplitLeg[] {
  if (legs.length === 0) return legs;

  const total = splitTotalCents(legs);
  const remaining = targetCents - total;
  if (remaining === 0) return legs;

  const emptyIndexes = legs
    .map((leg, index) => (leg.amountCents === 0 ? index : -1))
    .filter(index => index >= 0);

  if (emptyIndexes.length > 0) {
    return spreadEvenly(legs, emptyIndexes, remaining);
  }

  // The legs cancel each other out, so there is no proportion to follow:
  // the target is spread evenly instead.
  if (total === 0) {
    return spreadEvenly(
      legs,
      legs.map((_, index) => index),
      targetCents,
    );
  }

  // Each leg's exact share of the target, in cents.
  const exact = legs.map(leg => (leg.amountCents * targetCents) / total);
  const amounts = exact.map(value => Math.round(value));

  // The rounding leaves a cent or two over. They go to the legs that lost
  // the most in the rounding, so the sum is EXACTLY the target.
  let leftover = targetCents - amounts.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({
      index,
      loss: Math.abs(value - Math.round(value)),
    }))
    .sort((a, b) => b.loss - a.loss);

  for (const { index } of order) {
    if (leftover === 0) break;
    const step = Math.sign(leftover);
    amounts[index] += step;
    leftover -= step;
  }

  let out = legs;
  amounts.forEach((cents, index) => {
    out = replaceLeg(out, index, { ...legs[index], amountCents: cents });
  });
  return out;
}
