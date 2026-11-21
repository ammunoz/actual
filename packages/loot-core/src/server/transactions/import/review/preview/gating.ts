/**
 * The trust-level gate: what the current trust level does to each row.
 *
 * This is the layer that makes the trust level real. Without it the level is
 * a label: every row is imported whatever the resolver found, and the
 * matrix in `resolver/flags.ts` is dead code.
 *
 * Two ideas live here, and they are different:
 *
 *   1. **Effective flags.** The flags on a row describe what the RESOLVER
 *      found when the file was parsed. They go stale the moment the user
 *      edits the row: a row flagged `unknown-payee` that the user has
 *      since given a payee is not an unknown payee any more. `effectiveFlags`
 *      computes the flags that still apply.
 *
 *   2. **The gate.** `evaluateRow` turns those flags into the row's
 *      outcome under a trust level: whether it lands, whether the gate is
 *      holding it back, and whether the user is allowed to override.
 *
 * The override rules, in one place:
 *
 *   - A **hard block** (`amount-mismatch`, `date-out-of-range`) describes
 *     broken data, not a matter of trust. The row cannot be imported
 *     correctly, so the gate holds it and the user cannot wave it through —
 *     they have to FIX it, which clears the flag.
 *   - Every other block is a **soft block**. The gate holds the row, and
 *     the user can override it deliberately.
 *   - The gate holds over a plain accept. A row the user accepted while the
 *     level was permissive is held back again if the level is raised, and
 *     is released again if the level is lowered. Only an explicit override
 *     survives a stricter level.
 *
 * Pure: every helper takes the row and returns a new value. Nothing here
 * reads the database, calls `send()`, or knows about React.
 */

import {
  isHardBlock,
  outcomeFor,
} from '#server/transactions/import/review/resolver/flags';
import type {
  Flag,
  TrustLevel,
} from '#server/transactions/import/review/types';

import type { PreviewDecision, PreviewRow } from './preview-state';

/**
 * What the gate does to a row.
 *
 *   `allow`  nothing is wrong with the row; it lands.
 *   `warn`   the row carries a flag worth looking at; it lands.
 *   `skip`   the gate holds the row back unless it is overridden.
 *   `block`  the gate holds the row back; only an override releases it.
 */
export type RowGate = 'allow' | 'warn' | 'skip' | 'block';

const GATE_SEVERITY: Readonly<Record<RowGate, number>> = Object.freeze({
  allow: 0,
  warn: 1,
  skip: 2,
  block: 3,
});

/**
 * The options the gate needs beyond the row itself.
 */
export type GateOpts = {
  /**
   * The names of the payees that exist in the budget, normalised to
   * lower case.
   *
   * Only used to decide whether a payee the user picked still has to be
   * CREATED — the `would-create-payee` flag. When it is absent the flag is
   * left in place, which is the conservative answer: the flag only warns,
   * so leaving it on costs the user a badge, not a transaction.
   */
  livePayeeNames?: ReadonlySet<string>;
};

/**
 * What the gate says about one row.
 */
export type RowEvaluation = {
  /** The gate outcome under the current trust level. */
  gate: RowGate;
  /**
   * Whether the gate is holding this row back from being imported.
   *
   * A dropped row is never "held": the user threw it away, which is a
   * stronger statement than the gate.
   */
  held: boolean;
  /** Whether the row will be written to the budget. */
  willImport: boolean;
  /**
   * Whether the engine can accept the row AT ALL.
   *
   * A row whose date the file did not supply makes the whole import throw:
   * Actual's matching pass does `subDays(trans.date, 7)` while it is
   * looking for a fuzzy match, which is an invalid date operation, and it
   * happens BEFORE the row is looked at for `skipTransaction`.
   *
   * So such a row is not sent at all — not even marked as skipped. Marking
   * it is not enough: the engine throws before it gets that far.
   *
   * A row that is not sent is also not in the import preview, so it never
   * learns which transaction it matched. Fixing it therefore imports it as
   * a NEW transaction rather than updating the one it repeats.
   */
  willSend: boolean;
  /**
   * Whether the user may override the gate for this row.
   *
   * False for a hard-blocked row: its data is broken, and only fixing it
   * clears the flag.
   */
  overridable: boolean;
  /** Whether the user has already overridden the gate for this row. */
  overridden: boolean;
  /** The flags that still apply to the row. */
  flags: readonly Flag[];
};

/**
 * Pure: normalise a payee name the way the payload builder does, so the
 * gate and the payload agree on when two names are the same payee.
 */
export function normalizePayeeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Pure: whether a date is one the import would accept.
 *
 * The shape is not enough: `2026-02-31` is shaped like a date but is not
 * one, and this is the ONLY thing that releases the `date-out-of-range`
 * hard block. A shaped-but-impossible date would let broken data through.
 *
 * The round trip is what tells a real date from a well-shaped one: the
 * Date constructor rolls `2026-02-31` over into March, so the parts come
 * back different.
 */
export function isUsableDate(date: string | undefined): boolean {
  if (date === undefined) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

/**
 * Pure: the flags that still apply to the row, given the edits the user has
 * made to it.
 *
 * The rule is EDIT-based, not value-based: a flag is cleared by the user
 * doing something about it, not by the row happening to look a certain way.
 * A value-based rule would clear `unknown-payee` on a row that merely has a
 * payee name, which is not the same thing as the user having chosen one.
 *
 * The two DATA-LEVEL flags are handled differently, and the difference
 * matters:
 *
 *   - `date-out-of-range` is DERIVED from the row's effective date. A date
 *     is either usable or it is not, so the flag is a property of the value
 *     that would be sent. That way a row whose date the user has just
 *     broken is as broken as one the file broke, and a row whose date the
 *     user has just fixed is no longer broken at all.
 *   - `amount-mismatch` is NOT derived, because a row whose amount is 0
 *     cents is not necessarily broken: it is only broken if the FILE said
 *     so. It is cleared by the user committing an amount, and added again
 *     if the amount they committed is not a whole number of cents.
 */
export function effectiveFlags(
  row: PreviewRow,
  opts: GateOpts = {},
): readonly Flag[] {
  const flags = row.flags ?? [];

  // The user picked a payee. An empty name is not a choice.
  const chosenPayee = row.edits.payeeCanonical;
  const userPickedPayee =
    chosenPayee !== undefined && chosenPayee.trim() !== '';
  const userPickedAmount = row.edits.amountCents !== undefined;

  const kept = flags.filter(flag => {
    switch (flag.kind) {
      case 'unknown-payee':
        // The user gave the row a payee, so it is not unknown any more.
        return !userPickedPayee;

      case 'fuzzy-payee-match':
        // The user chose a payee deliberately, so the match is no longer
        // the resolver's guess.
        return !userPickedPayee;

      case 'would-create-payee': {
        // The flag says the import will CREATE a payee. It stops being
        // true only when the user picked a payee the budget already has.
        if (!userPickedPayee) return true;
        const live = opts.livePayeeNames;
        if (!live) return true;
        return !live.has(normalizePayeeName(chosenPayee));
      }

      case 'amount-mismatch':
        // The user committed an amount, so the file's unusable one no
        // longer matters.
        //
        // Unlike the date, this flag is NOT derived from the effective
        // amount: a row whose amount is 0 cents is not necessarily broken,
        // it is only broken if the FILE said so.
        return !userPickedAmount;

      case 'transfer-detected':
      case 'transfer-suspected':
      case 'transfer-ambiguous':
        // The row stops being flagged once the user confirms a transfer or
        // replaces it with an ordinary payee. The warning has done its job.
        return !(row.edits.transferAccountId !== undefined || userPickedPayee);

      case 'date-out-of-range':
        // Decided below, from the date that would actually be sent.
        return false;

      case 'duplicate':
      default:
        // Nothing the user does in the review clears these: a repeated
        // FITID is a property of the file, not of the row's edits.
        return true;
    }
  });

  // The data-level flags describe the EFFECTIVE values, so they are
  // derived rather than kept or dropped.
  //
  // The derived flags carry no note. The note on the parse-time flag says
  // WHERE the problem came from ("the file did not supply a usable date"),
  // which is not true of an edit, and nothing reads it: it is documented as
  // never being a user-visible value. The UI shows its own reason for the
  // flag kind.
  const effectiveDate = row.edits.date ?? row.date;
  const effectiveAmount = row.edits.amountCents ?? row.amountCents;

  if (!isUsableDate(effectiveDate)) {
    kept.push({ kind: 'date-out-of-range', code: 'DATE-RANGE-001' });
  }
  // The guard is belt and braces: the parse-time flag is kept when the
  // user committed no amount, and an amount is only ever unusable if it is
  // not a whole number of cents.
  if (
    !Number.isInteger(effectiveAmount) &&
    !kept.some(flag => flag.kind === 'amount-mismatch')
  ) {
    kept.push({ kind: 'amount-mismatch', code: 'AMT-MISMATCH-001' });
  }

  return kept;
}

/**
 * Pure: the gate outcome of a row under a trust level.
 */
export function gateRow(
  row: PreviewRow,
  trustLevel: TrustLevel,
  opts: GateOpts = {},
): RowGate {
  return gateFromFlags(effectiveFlags(row, opts), trustLevel);
}

/**
 * Pure: the worst outcome among a set of flags.
 */
export function gateFromFlags(
  flags: readonly Flag[],
  trustLevel: TrustLevel,
): RowGate {
  let worst: RowGate = 'allow';
  for (const flag of flags) {
    const outcome = outcomeFor(flag.kind, trustLevel);
    const gate: RowGate =
      outcome === 'block' ? 'block' : outcome === 'skip' ? 'skip' : 'warn';
    if (GATE_SEVERITY[gate] > GATE_SEVERITY[worst]) worst = gate;
  }
  return worst;
}

/**
 * Pure: what the gate says about one row — its outcome, whether it is held
 * back, whether it lands, and whether the user may override.
 */
export function evaluateRow(
  row: PreviewRow,
  trustLevel: TrustLevel,
  opts: GateOpts = {},
): RowEvaluation {
  const flags = effectiveFlags(row, opts);
  const gate = gateFromFlags(flags, trustLevel);
  const hardBlocked = flags.some(flag => isHardBlock(flag.kind));
  const decision: PreviewDecision = row.decision;
  const overridden = decision === 'accept-override';
  const dropped = decision === 'drop';

  // Whether the engine can accept the row at all. The EFFECTIVE date and
  // amount are what would be sent, so a row the user fixed is judged on
  // the fixed values.
  const effectiveDate = row.edits.date ?? row.date;
  const effectiveAmount = row.edits.amountCents ?? row.amountCents;
  const willSend =
    isUsableDate(effectiveDate) && Number.isInteger(effectiveAmount);

  // A hard block holds the row even against an override: the data is
  // broken, and the import would reject it or write it wrong.
  const willImport =
    !dropped &&
    willSend &&
    !hardBlocked &&
    (overridden || gate === 'allow' || gate === 'warn');

  return {
    gate,
    held: !dropped && !willImport,
    willImport,
    willSend,
    overridable: !hardBlocked,
    overridden,
    flags,
  };
}
