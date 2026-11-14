/**
 * Flag pipeline: helpers for attaching flags to rows and bucketing them by
 * trust level.
 *
 * Trust-level gating matrix:
 *
 *     | kind                 | paranoid | cautious | trusted |
 *     |----------------------|----------|----------|---------|
 *     | unknown-payee        | block    | block    | warn    |
 *     | payee-rule-conflict  | block    | block    | warn    |
 *     | amount-mismatch      | block    | block    | warn    |
 *     | date-out-of-range    | block    | block    | warn    |
 *     | needs-review         | block    | warn     | warn    |
 *     | duplicate            | block    | skip     | skip    |
 *     | fuzzy-payee-match    | block    | warn     | warn    |
 *     | would-create-payee   | warn     | warn     | warn    |
 *     | transfer-detected    | warn     | warn     | warn    |
 *
 * Multi-flag priority is `block > skip > warn`. A single block on any flag
 * puts the row in `blocked` even if another flag says `skip`. Rows with no
 * flags land in `warned`.
 *
 * Flag kinds and codes are generic across vendors; no bank-specific labels.
 * Codes are intentionally stable strings so log messages, UI badges, and
 * tests can grep them.
 */

import type {
  Flag,
  FlagCode,
  FlagKind,
  ResolvedRow,
  TrustLevel,
} from '#server/transactions/import/review/types';

export type GateOutcome = 'block' | 'skip' | 'warn';

export type GateResult = {
  blocked: readonly ResolvedRow[];
  skipped: readonly ResolvedRow[];
  warned: readonly ResolvedRow[];
};

const OUTCOME_MATRIX: Readonly<
  Record<FlagKind, Readonly<Record<TrustLevel, GateOutcome>>>
> = Object.freeze({
  'unknown-payee': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'warn',
  }),
  'payee-rule-conflict': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'warn',
  }),
  'amount-mismatch': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'warn',
  }),
  'date-out-of-range': Object.freeze({
    paranoid: 'block',
    cautious: 'block',
    trusted: 'warn',
  }),
  'needs-review': Object.freeze({
    paranoid: 'block',
    cautious: 'warn',
    trusted: 'warn',
  }),
  duplicate: Object.freeze({
    paranoid: 'block',
    cautious: 'skip',
    trusted: 'skip',
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
  // Auto-detected transfers start as a prefill, not a fact: the user must
  // confirm (or unset) the row like any other pending decision. Warn at
  // every trust level so the badge always surfaces, but never blocks — a
  // false-positive detection is reverted with one keypress, not an error.
  'transfer-detected': Object.freeze({
    paranoid: 'warn',
    cautious: 'warn',
    trusted: 'warn',
  }),
});

const SEVERITY: Readonly<Record<GateOutcome, number>> = Object.freeze({
  block: 3,
  skip: 2,
  warn: 1,
});

/**
 * Pure: return a new row with `flags` extended by one. The input row is
 * spread, not mutated.
 */
export function flagFor<T extends ResolvedRow>(
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
 * Pure: bucket rows by their worst-severity flag outcome under the given
 * trust level. Severity: `block > skip > warn`. Rows with no flags land in
 * `warned`.
 */
export function gateByTrustLevel(
  rows: readonly ResolvedRow[],
  trustLevel: TrustLevel,
): GateResult {
  const blocked: ResolvedRow[] = [];
  const skipped: ResolvedRow[] = [];
  const warned: ResolvedRow[] = [];

  for (const row of rows) {
    const outcome = worstOutcome(row, trustLevel);
    if (outcome === 'block') {
      blocked.push(row);
    } else if (outcome === 'skip') {
      skipped.push(row);
    } else {
      warned.push(row);
    }
  }

  return Object.freeze({
    blocked: Object.freeze(blocked) as readonly ResolvedRow[],
    skipped: Object.freeze(skipped) as readonly ResolvedRow[],
    warned: Object.freeze(warned) as readonly ResolvedRow[],
  });
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

function worstOutcome(row: ResolvedRow, trustLevel: TrustLevel): GateOutcome {
  if (!row.flags || row.flags.length === 0) return 'warn';
  let worst: GateOutcome = 'warn';
  for (const flag of row.flags) {
    const outcome = OUTCOME_MATRIX[flag.kind][trustLevel];
    if (SEVERITY[outcome] > SEVERITY[worst]) worst = outcome;
  }
  return worst;
}
