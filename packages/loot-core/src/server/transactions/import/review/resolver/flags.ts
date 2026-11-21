/**
 * Flag pipeline: helpers for attaching flags to rows, and the trust-level
 * matrix that says what each flag does at each trust level.
 *
 * Trust-level gating matrix:
 *
 *     | kind                 | paranoid | cautious | trusted |
 *     |----------------------|----------|----------|---------|
 *     | unknown-payee        | block    | block    | warn    |
 *     | amount-mismatch      | block    | block    | block   |
 *     | date-out-of-range    | block    | block    | block   |
 *     | duplicate            | block    | skip     | warn    |
 *     | fuzzy-payee-match    | block    | warn     | warn    |
 *     | would-create-payee   | warn     | warn     | warn    |
 *     | transfer-detected    | warn     | warn     | warn    |
 *     | transfer-suspected   | warn     | warn     | warn    |
 *     | transfer-ambiguous   | warn     | warn     | warn    |
 *
 * Multi-flag priority is `block > skip > warn`. A single block on any flag
 * puts the row in `blocked` even if another flag says `skip`. A row with no
 * flags is not gated at all.
 *
 * Two deliberate differences from the TUI matrix this was ported from:
 *
 *   - `amount-mismatch` and `date-out-of-range` block at EVERY level,
 *     including `trusted`. They are not a matter of trust: a row whose date
 *     the file did not supply is rejected by the import, and a row whose
 *     amount was unusable would be written as a real $0 transaction. No
 *     amount of trust makes broken data importable. See `isHardBlock`.
 *
 *   - `duplicate` degrades to `warn` at `trusted`, so `trusted` really does
 *     mean "hold nothing back". A trust level that still holds rows back is
 *     not a trust level the user can reason about.
 *
 * Flag kinds and codes are generic across vendors; no bank-specific labels.
 * Codes are intentionally stable strings so log messages, UI badges, and
 * tests can grep them.
 */

import type {
  Flag,
  FlagCode,
  FlagKind,
  ReviewRowInput,
  TrustLevel,
} from '#server/transactions/import/review/types';

export type GateOutcome = 'block' | 'skip' | 'warn';

const OUTCOME_MATRIX: Readonly<
  Record<FlagKind, Readonly<Record<TrustLevel, GateOutcome>>>
> = Object.freeze({
  'unknown-payee': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'warn',
  }),
  // The two hard blocks: the row's data is broken, so it cannot be
  // imported correctly at any trust level. See `isHardBlock`.
  'amount-mismatch': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'block',
  }),
  'date-out-of-range': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'block',
  }),
  duplicate: Object.freeze({
    paranoid: 'block',
    cautious: 'skip',
    trusted: 'warn',
  }),
  'fuzzy-payee-match': Object.freeze({
    paranoid: 'block',
    cautious: 'warn',
    trusted: 'warn',
  }),
  'would-create-payee': Object.freeze({
    paranoid: 'warn',
    cautious: 'warn',
    trusted: 'warn',
  }),
  // An auto-detected transfer is a DEFAULT, not a guess: the row becomes a
  // transfer unless the user says otherwise. Warn at every trust level so
  // the badge always surfaces, but never block — a false-positive
  // detection is reverted with one keypress, not an error.
  'transfer-detected': Object.freeze({
    paranoid: 'warn',
    cautious: 'warn',
    trusted: 'warn',
  }),
  // A bank string that LOOKS like a transfer but does not name an account we
  // know. Nothing is prefilled, so there is no destructive action to guard
  // against — only a nudge for the user to look at the row. Warn always.
  'transfer-suspected': Object.freeze({
    paranoid: 'warn',
    cautious: 'warn',
    trusted: 'warn',
  }),
  // Several identical transfers to the same account are already in the
  // budget. The row may be one of them; the user can drop it with `r`.
  // Warn always, never block — a false positive only costs a look.
  'transfer-ambiguous': Object.freeze({
    paranoid: 'warn',
    cautious: 'warn',
    trusted: 'warn',
  }),
});

/**
 * The flag kinds that describe BROKEN DATA rather than a matter of trust.
 *
 * A hard block is not a policy the user can relax: the row cannot be
 * imported correctly at all.
 *
 *   - `amount-mismatch`: the file supplied no usable amount, so the row
 *     would be written as a real $0 transaction.
 *   - `date-out-of-range`: the file supplied no usable date, and the import
 *     rejects a row without one.
 *
 * A hard-blocked row can still be made importable — by FIXING it, which
 * clears the flag — but it cannot be waved through by overriding the gate.
 * See `RowEvaluation.overridable` (`preview/gating.ts`).
 */
const HARD_BLOCKS: ReadonlySet<FlagKind> = Object.freeze(
  new Set<FlagKind>(['amount-mismatch', 'date-out-of-range']),
);

/**
 * Pure: whether this flag kind is a hard block — one the user cannot
 * override, only fix.
 */
export function isHardBlock(kind: FlagKind): boolean {
  return HARD_BLOCKS.has(kind);
}

/**
 * Pure: return a new row with `flags` extended by one. The input row is
 * spread, not mutated.
 */
export function flagFor<T extends { flags?: readonly Flag[] }>(
  row: T,
  kind: FlagKind,
  code: FlagCode,
  note?: string,
): T & { flags: readonly Flag[] } {
  const existing: readonly Flag[] = row.flags ?? [];
  const flag: Flag = note === undefined ? { kind, code } : { kind, code, note };
  return { ...row, flags: [...existing, flag] };
}

/**
 * Pure: flag the rows whose FITID repeats one that came earlier in the
 * file.
 *
 * The FIRST occurrence is left alone. A file that repeats a transaction
 * still describes one transaction, and the first row is the one that
 * describes it: the repeat is the problem, and the repeat is the row that
 * would be imported on top of the first.
 *
 * The flag describes the FILE, not what the user did with the rows. If the
 * user drops the first occurrence, the repeat is still a repeat: the trust
 * level still skips it, and the user can override it deliberately.
 *
 * A row with no FITID is never flagged: there is nothing to repeat.
 *
 * This is the only flag that maps to `skip`, so without it the `skip`
 * branch of the matrix would be unreachable.
 */
export function flagDuplicateFitids<
  T extends ReviewRowInput & { flags?: readonly Flag[] },
>(rows: readonly T[]): readonly (T & { flags?: readonly Flag[] })[] {
  const seen = new Set<string>();
  return rows.map(row => {
    const id = row.importedId;
    if (id === undefined || id === '') return row;
    if (!seen.has(id)) {
      seen.add(id);
      return row;
    }
    return flagFor(row, 'duplicate', 'FITID-DUP-001');
  });
}

/**
 * Pure: the flags the FILE raises about a row.
 *
 * A row's flags are a mixture: some describe the file (its amount is
 * unreadable, its date is impossible) and some describe the RESOLUTION
 * (the resolver did not know the payee, it looks like a transfer). The
 * second kind is recomputed every time the rows are resolved, so carrying
 * it over would raise it a second time.
 *
 * The duplicate-FITID flags are the file's too, but they are recomputed
 * from the rows themselves (`flagDuplicateFitids`), so they are left out
 * here as well: the function that raises them is the one that knows
 * whether they apply.
 */
export function fileFlags(row: { flags?: readonly Flag[] }): readonly Flag[] {
  return (row.flags ?? []).filter(
    flag =>
      flag.kind === 'amount-mismatch' || flag.kind === 'date-out-of-range',
  );
}

/**
 * Pure: the gate outcome for a single flag kind under a trust level.
 */
export function outcomeFor(
  kind: FlagKind,
  trustLevel: TrustLevel,
): GateOutcome {
  return OUTCOME_MATRIX[kind][trustLevel];
}
