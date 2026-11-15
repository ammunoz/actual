/**
 * Split-leg primitives. Pure, shared, and IO-free.
 *
 * A "split" lets the user target SEVERAL budget categories for one bank
 * transaction — e.g. a single charge of -$100.00 that is -$85.00 groceries
 * and -$15.00 household. The parent row keeps its payee (the bank-supplied
 * vendor), its date, its `imported_id` (the FITID, which is what the apply
 * step dedups on), and its notes; the CATEGORIES live on the legs.
 *
 * Why legs carry no payee: upstream's `makeChild` inherits the parent's payee
 * unless the child payload contains a `payee` key, so omitting the key is
 * exactly how we say "same payee as the parent".
 *
 * Pure: every helper returns a new frozen array; no input is mutated and
 * nothing here touches React, the filesystem, or the server.
 *
 * The `subtransactions` payload assembly deliberately does NOT live here —
 * the apply path needs the live category id set, and the editor needs the
 * write lock and the parent row it is splitting.
 *
 * Error messages carry a code, an index, and a count — never a category
 * name, a payee, or an amount the user typed.
 */

/**
 * One leg of a user-authored split. Legs are LEAVES: there is no nesting
 * (upstream's `makeChild` builds plain children and ignores nested
 * `subtransactions`, so a nested split would be silently dropped).
 */
export type PreviewSplitLeg = {
  /**
   * Integer cents, signed the same way as the parent row: negative for
   * money out, positive for money in. The SUM must equal the parent's
   * effective amount (see `validateSplit`).
   */
  amountCents: number;
  /**
   * Budget category id. The name is NOT snapshotted — it is looked up at
   * render time. Every leg must carry one before the split can be
   * committed.
   */
  categoryId?: string;
};

/**
 * Hard cap on legs per split. Bounds what the review pane has to render and
 * what a serialized session has to carry.
 */
export const MAX_SPLIT_LEGS = 20;

/**
 * Codes emitted by `validateSplit` and `validateSplitRow`.
 *
 * Stable, greppable, value-free.
 */
export type SplitErrorCode =
  | 'SPLIT-001'
  | 'SPLIT-002'
  | 'SPLIT-003'
  | 'SPLIT-004'
  | 'SPLIT-005'
  | 'SPLIT-006';

export class SplitValidationError extends Error {
  readonly code: SplitErrorCode;
  constructor(code: SplitErrorCode, message: string) {
    super(message);
    this.name = 'SplitValidationError';
    this.code = code;
  }
}

function freezeLeg(leg: PreviewSplitLeg): PreviewSplitLeg {
  // Every field is listed. `freezeLeg` REBUILDS the object rather than
  // spreading it, so anything not named here is lost.
  return Object.freeze({
    amountCents: leg.amountCents,
    ...(leg.categoryId !== undefined && { categoryId: leg.categoryId }),
  }) as PreviewSplitLeg;
}

function freezeLegs(
  legs: readonly PreviewSplitLeg[],
): readonly PreviewSplitLeg[] {
  return Object.freeze(legs.map(freezeLeg)) as readonly PreviewSplitLeg[];
}

/** Sum of the leg amounts, in cents. An empty list sums to 0. */
export function splitTotalCents(legs: readonly PreviewSplitLeg[]): number {
  let total = 0;
  for (const leg of legs) total += leg.amountCents;
  return total;
}

/**
 * `target - sum(legs)`, in cents: the amount a NEW leg would have to carry
 * to close the gap. Zero means balanced.
 *
 * The value is signed the way the row is signed, so it is directly usable
 * as a leg amount. On a -$25.00 debit whose legs sum to -$20.00 the
 * residual is -500 (a -$5.00 debit leg is still missing); on that same row
 * with legs summing to -$30.00 it is +500 (the legs allocate $5.00 of debit
 * too much, and a +$5.00 leg brings the sum back).
 *
 * Do not read the direction off the residual's sign. That only works when
 * the target is negative. Use `splitResidualDirection`, which compares the
 * leg total against the target.
 */
export function splitResidualCents(
  legs: readonly PreviewSplitLeg[],
  targetCents: number,
): number {
  return targetCents - splitTotalCents(legs);
}

/**
 * Which way the legs are off, in words a user can act on.
 *
 *   `balanced`     the legs sum to the target
 *   `exceed`       the legs allocate MORE than the target
 *   `unallocated`  the legs allocate LESS than the target
 *
 * Derived from the leg TOTAL and the target, never from the residual's bare
 * sign — the residual's sign is positive for a debit overshoot and for an
 * inflow shortfall alike.
 */
export type SplitResidualDirection = 'balanced' | 'exceed' | 'unallocated';

export function splitResidualDirection(
  legs: readonly PreviewSplitLeg[],
  targetCents: number,
): SplitResidualDirection {
  const total = splitTotalCents(legs);
  if (total === targetCents) return 'balanced';
  // The legs OVERSHOOT when they run in the row's own direction and go past
  // it. A zero target counts as "in the row's direction" for either sign, so
  // any non-zero leg total on a zero row reads `exceed`.
  const sameDirection =
    targetCents === 0 || Math.sign(total) === Math.sign(targetCents);
  return sameDirection && Math.abs(total) > Math.abs(targetCents)
    ? 'exceed'
    : 'unallocated';
}

/**
 * How many legs are still missing a category.
 *
 * An EMPTY-STRING `categoryId` counts as missing: the empty string is
 * the domain's "cleared" marker, not a category id, and a leg with one
 * has no category to send. A STALE id — a category that has been
 * deleted — still counts as set: that is a well-formed id, and only the
 * apply step knows which ids are live.
 */
export function uncategorizedLegCount(
  legs: readonly PreviewSplitLeg[],
): number {
  let n = 0;
  for (const leg of legs) if (!leg.categoryId) n += 1;
  return n;
}

/**
 * Pure: the opening state for the split editor — TWO legs that already sum
 * to `amountCents`, each seeded with `categoryId` so the pane opens balanced
 * and the user's remaining job is only "give each leg its own category".
 *
 * The split is done on the absolute value and the sign is re-applied, so a
 * -$25.01 row seeds as -$12.51 / -$12.50 rather than one leg positive. Odd
 * cents land on the FIRST leg so the two are never equal-and-therefore-more
 * suspect than they need to be.
 */
export function seedSplit(
  amountCents: number,
  categoryId?: string,
): readonly PreviewSplitLeg[] {
  const sign = amountCents < 0 ? -1 : 1;
  const abs = Math.abs(amountCents);
  const first = Math.ceil(abs / 2);
  return freezeLegs([
    {
      amountCents: sign * first,
      ...(categoryId !== undefined && { categoryId }),
    },
    {
      amountCents: sign * (abs - first),
      ...(categoryId !== undefined && { categoryId }),
    },
  ]);
}

/**
 * Pure: append a leg sized at the current residual so the sum invariant is
 * preserved by the keystroke. When the split already balances, the new leg
 * starts at 0 and the footer shows nothing to fix — the user is expected to
 * move some amount onto it, and the balance gate blocks the commit until they
 * do. A non-zero residual closes the gap exactly, sign included.
 *
 * A no-op at `MAX_SPLIT_LEGS`.
 */
export function addLeg(
  legs: readonly PreviewSplitLeg[],
  residualCents: number,
  categoryId?: string,
): readonly PreviewSplitLeg[] {
  if (legs.length >= MAX_SPLIT_LEGS) return legs;
  // The residual is used VERBATIM, sign included. A negative residual on a
  // debit is not clamped to zero: a -$20.00 residual on a -$100.00 row means
  // a -$20.00 debit leg is missing, and clamping it to 0 would add a leg
  // that does not close the gap.
  return freezeLegs([
    ...legs,
    {
      amountCents: residualCents,
      ...(categoryId !== undefined && { categoryId }),
    },
  ]);
}

/**
 * Pure: drop the leg at `index`. Clamps at ONE remaining leg — the editor
 * never produces a zero-leg (or one-leg) list, because a one-leg split is
 * indistinguishable from an ordinary categorized row. Un-splitting is
 * expressed by clearing the field entirely, not by removing legs.
 *
 * Out-of-range indices are a no-op.
 */
export function removeLeg(
  legs: readonly PreviewSplitLeg[],
  index: number,
): readonly PreviewSplitLeg[] {
  if (legs.length <= 1) return legs;
  if (!Number.isInteger(index) || index < 0 || index >= legs.length) {
    return legs;
  }
  return freezeLegs(legs.filter((_, i) => i !== index));
}

/**
 * Pure: replace the leg at `index`. Out-of-range is a no-op. Returns a NEW
 * array (never mutates), so the editor can hold the draft outside the
 * preview state and only write it into the edits on commit.
 */
export function replaceLeg(
  legs: readonly PreviewSplitLeg[],
  index: number,
  next: PreviewSplitLeg,
): readonly PreviewSplitLeg[] {
  if (!Number.isInteger(index) || index < 0 || index >= legs.length) {
    return legs;
  }
  const out = legs.map((leg, i) => (i === index ? freezeLeg(next) : leg));
  return Object.freeze(out) as readonly PreviewSplitLeg[];
}

/**
 * Pure: check a split against the row's effective amount. Returns `null`
 * when the split may be committed, or a `SplitValidationError` for the FIRST
 * problem found, in this order:
 *
 *   SPLIT-001  fewer than 2 legs (not a split)
 *   SPLIT-002  more than `MAX_SPLIT_LEGS` legs
 *   SPLIT-003  a leg amount is not an integer number of cents
 *   SPLIT-004  legs do not sum to the target amount
 *   SPLIT-005  at least one leg has no category
 *
 * `SPLIT-005` treats an empty-string `categoryId` as NOT set: the empty
 * string is the "cleared" marker, not a category id. A STALE id — a
 * category that has been deleted since — still counts as set, because
 * this function validates SHAPE and only the apply step knows which ids
 * are live; its category filter downgrades a stale id to `null` at send
 * time.
 *
 * Both SPLIT-004 and SPLIT-005 are hard blocks rather than warnings because
 * upstream records an imbalance as a split error on the parent and an
 * uncategorized leg is a silent data-quality regression.
 */
export function validateSplit(
  legs: readonly PreviewSplitLeg[],
  targetCents: number,
): SplitValidationError | null {
  if (legs.length < 2) {
    return new SplitValidationError(
      'SPLIT-001',
      `SPLIT-001: a split needs at least 2 legs (got ${legs.length})`,
    );
  }
  if (legs.length > MAX_SPLIT_LEGS) {
    return new SplitValidationError(
      'SPLIT-002',
      `SPLIT-002: a split may have at most ${MAX_SPLIT_LEGS} legs (got ${legs.length})`,
    );
  }
  for (let i = 0; i < legs.length; i += 1) {
    const cents = legs[i].amountCents;
    if (typeof cents !== 'number' || !Number.isInteger(cents)) {
      return new SplitValidationError(
        'SPLIT-003',
        `SPLIT-003: leg ${i + 1} amount is not an integer number of cents`,
      );
    }
  }
  const residual = splitResidualCents(legs, targetCents);
  if (residual !== 0) {
    return new SplitValidationError(
      'SPLIT-004',
      `SPLIT-004: legs do not sum to the row amount (off by ${residual} cents)`,
    );
  }
  const uncategorized = uncategorizedLegCount(legs);
  if (uncategorized > 0) {
    return new SplitValidationError(
      'SPLIT-005',
      `SPLIT-005: ${uncategorized} leg(s) have no category`,
    );
  }
  return null;
}
