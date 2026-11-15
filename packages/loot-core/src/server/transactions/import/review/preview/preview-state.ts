/**
 * In-memory preview state for the import review.
 *
 * The review view shows the parsed/resolved rows and lets the user
 * accept/drop/edit each one. Decisions live in this state until the apply
 * step reads them.
 *
 * Pure: every helper returns a new state; input arrays and rows are not
 * mutated.
 *
 * The preview state is in-memory only. The apply step forwards the resolved
 * rows over the secure channel.
 */

import type {
  ResolvedRow,
  TrustLevel,
} from '#server/transactions/import/review/types';

import { evaluateRow } from './gating';
import type { GateOpts, RowEvaluation } from './gating';
import type { PreviewSplitLeg } from './split-primitives';

/**
 * What the user decided about a row.
 *
 *   `pending`         not decided yet; the row lands unless the gate holds
 *                     it back.
 *   `accept`          the user accepted the row. The gate still applies: a
 *                     row the gate holds back is not imported, and it is
 *                     released again if the trust level is lowered.
 *   `accept-override` the user accepted the row DESPITE its flags. This is
 *                     the only decision that survives a stricter trust
 *                     level, and the only way past a soft block.
 *   `drop`            the user threw the row away.
 */
export type PreviewDecision = 'pending' | 'accept' | 'accept-override' | 'drop';

export type PreviewEdits = {
  /** The payee name the user chose. */
  payeeCanonical?: string;
  /** The amount the user committed, in cents. */
  amountCents?: number;
  /** The date the user committed. */
  date?: string;
  /**
   * User override for the bank-supplied memo.
   *
   *   `undefined` → the user has not touched the memo; the apply step sends
   *                 the bank-supplied value.
   *   `''`        → the user explicitly cleared it; the apply step sends
   *                 empty notes.
   *   any string  → user-set notes, sent verbatim.
   */
  memo?: string;
  /**
   * User-assigned budget category id.
   *
   *   `undefined` → the user has not picked one; the apply step falls back
   *                 to the category the resolver found, and Actual's rules
   *                 pick whatever default applies.
   *   `''`        → the user CLEARED the category; the row is imported
   *                 without one.
   *
   * The two are different, and `undefined` cannot mean both: the payload
   * builder falls back to the resolver's category when the field is
   * undefined, so a cleared category has to be spelled out.
   */
  categoryId?: string;
  /**
   * User-set transfer target: the budget account id this row moves money
   * to/from. Set either by the resolver's auto-detect or manually.
   *
   * `undefined` → ordinary (non-transfer) row. Set → the apply step
   * converts the account id into the account's transfer payee id.
   */
  transferAccountId?: string;
  /**
   * User-authored split across SEVERAL budget categories. The parent row
   * keeps its payee (the bank vendor), date, `imported_id`, and notes; the
   * CATEGORIES live on the legs, because upstream nulls a split parent's
   * category regardless of what we send.
   *
   * Three states, and no empty-array sentinel:
   *   - `undefined` → ordinary row; the apply payload has no
   *                  `subtransactions` key at all.
   *   - array with 2..`MAX_SPLIT_LEGS` legs → imports as a split.
   *   - clearing the split writes `undefined` rather than `[]`. A zero-leg
   *     or one-leg list is not a state worth expressing: a single leg is
   *     indistinguishable from an ordinary categorized row.
   *
   * Mutually exclusive with `transferAccountId`.
   */
  splits?: readonly PreviewSplitLeg[];
};

/**
 * True when the row carries a user-authored split.
 *
 * Note this reads `edits.splits` ONLY — the transfer auto-detect is a
 * separate concern, resolved by `effectiveTransferAccountId`.
 */
export function isSplitRow(edits: PreviewEdits): boolean {
  return edits.splits !== undefined;
}

export type PreviewRow = ResolvedRow & {
  decision: PreviewDecision;
  edits: PreviewEdits;
};

export type ImportPreviewState = {
  rows: readonly PreviewRow[];
  trustLevel: TrustLevel;
};

export type PreviewSummary = {
  total: number;
  /**
   * Rows the gate is holding back with a `block`.
   *
   * A hard-blocked row is counted here even when the user overrode it: an
   * override cannot release it, because its data is broken.
   */
  blocked: number;
  /** Rows the gate is holding back with a `skip`. */
  skipped: number;
  /**
   * Rows carrying a warning.
   *
   * A row with no flags at all is not warned about. It is simply not gated,
   * and it is counted in `total` and in the decision counts.
   */
  warned: number;
  /** Rows the user accepted, whether or not they override a flag. */
  accepted: number;
  /** Rows the user accepted DESPITE their flags. */
  overridden: number;
  dropped: number;
  pending: number;
  /**
   * Rows that will land as money IN (inflow), and as money OUT.
   *
   * Counting basis is the rows that will actually be imported. Dropped rows
   * and rows the gate holds back are excluded, so these two numbers
   * describe the transactions that will reach the budget, not the contents
   * of the file. They therefore move as the user accepts, drops and
   * overrides, which is what makes the pair complementary to `accepted` /
   * `dropped` / `pending` rather than a restatement of `total`.
   *
   * Derived from `effectiveAmountCents`, so a user-signed amount edit is
   * reflected. A zero amount counts as neither.
   */
  inflowCount: number;
  outflowCount: number;
};

/**
 * The amount that will actually be written for this row: the user's amount
 * edit if they committed one, else the bank-supplied value.
 *
 * This is the single source of truth for "what amount is this row?". Five
 * sites need it and MUST agree: the amount editor's seed buffer, the row
 * display, the details line, the summary's inflow/outflow split, and the
 * apply payload. A divergence between the preview and the apply step would
 * show the user one number and write another, so the expression is
 * extracted here rather than repeated.
 */
export function effectiveAmountCents(row: PreviewRow): number {
  return row.edits.amountCents ?? row.amountCents;
}

/**
 * The transfer account id that actually applies to this row: the user's
 * explicit choice if they made one, otherwise the resolver's auto-detect.
 *
 * The auto-detect is a *prefill*, not a fact — the row stays pending until
 * the user confirms it, at which point the editor writes the value into
 * `edits.transferAccountId`.
 */
export function effectiveTransferAccountId(
  row: PreviewRow,
): string | undefined {
  return row.edits.transferAccountId ?? row.matchedTransferAccountId;
}

/** Code emitted when a preview helper cannot find the row. */
export const PREVIEW_STATE_NOT_FOUND = 'PREVIEW-STATE-001' as const;

export class PreviewStateError extends Error {
  readonly code: typeof PREVIEW_STATE_NOT_FOUND;
  constructor(code: typeof PREVIEW_STATE_NOT_FOUND, message: string) {
    super(message);
    this.name = 'PreviewStateError';
    this.code = code;
  }
}

/**
 * The key that identifies a row within the preview state.
 *
 * This is the transient `previewKey` the parser assigns, NOT the FITID.
 *
 * The FITID looks like the obvious choice — it is what the apply step
 * dedups on — but it is not unique: some OFX files omit FITIDs entirely,
 * and a malformed file can repeat one. A row key has to identify exactly
 * one row, or a single decision would fan out across every row that
 * happens to share a FITID.
 *
 * The FITID is carried on the row as `importedId` for the dedup itself; the
 * `previewKey` only ever identifies a row inside the review.
 */
export function rowKey(
  row: Pick<PreviewRow, 'importedId' | 'previewKey'>,
): string {
  return row.previewKey ?? row.importedId ?? '';
}

/**
 * Pure: build an initial preview state from resolved rows. Every row starts
 * with `decision: 'pending'` and empty edits.
 */
export function buildPreviewState(
  rows: readonly ResolvedRow[],
  trustLevel: TrustLevel,
): ImportPreviewState {
  const previewRows: PreviewRow[] = rows.map(
    row =>
      Object.freeze({
        ...row,
        decision: 'pending' as const,
        edits: Object.freeze({}) as PreviewEdits,
      }) as PreviewRow,
  );
  return Object.freeze({
    rows: Object.freeze(previewRows) as readonly PreviewRow[],
    trustLevel,
  });
}

/**
 * Freeze an `edits` object for storage on a preview row.
 *
 * The state helpers promise immutability ("every helper returns a new state;
 * input arrays and rows are not mutated"), which a SHALLOW freeze does not
 * deliver once an edit carries a nested collection: `Object.freeze({...edits})`
 * leaves `edits.splits` as a mutable array reachable from a frozen parent.
 * Every collection-valued field is frozen here; scalar fields need nothing
 * beyond the parent.
 *
 * Kept as one function so `applyDecision` and `updateEdits` cannot drift on
 * which fields get the deep treatment.
 */
function freezeEdits(edits: PreviewEdits): PreviewEdits {
  const frozen: PreviewEdits = { ...edits };
  if (edits.splits !== undefined) {
    frozen.splits = Object.freeze(
      edits.splits.map(leg => Object.freeze({ ...leg })),
    ) as readonly PreviewSplitLeg[];
  }
  return Object.freeze(frozen) as PreviewEdits;
}

/**
 * Pure: return a new state with the row identified by `key` updated to the
 * given decision + edits. Throws `PreviewStateError` (`PREVIEW-STATE-001`)
 * if the row is not present.
 *
 * `edits` replaces the row's previous edits wholesale (no merge); the caller
 * passes the full desired edits object each time.
 */
export function applyDecision(
  state: ImportPreviewState,
  key: string,
  decision: PreviewDecision,
  edits?: PreviewEdits,
): ImportPreviewState {
  if (!key) {
    throw new PreviewStateError(
      PREVIEW_STATE_NOT_FOUND,
      'applyDecision requires a non-empty key',
    );
  }
  // Exactly ONE row is updated. The key is unique by construction, but
  // updating a single row keeps it that way: a duplicated key must never
  // fan one decision out across several rows.
  const index = state.rows.findIndex(row => rowKey(row) === key);
  if (index === -1) {
    throw new PreviewStateError(
      PREVIEW_STATE_NOT_FOUND,
      'applyDecision could not locate the row',
    );
  }
  const row = state.rows[index];
  const frozenEdits: PreviewEdits =
    edits === undefined ? row.edits : freezeEdits(edits);
  const nextRows = [...state.rows];
  nextRows[index] = Object.freeze({
    ...row,
    decision,
    edits: frozenEdits,
  }) as PreviewRow;
  return Object.freeze({
    rows: Object.freeze(nextRows) as readonly PreviewRow[],
    trustLevel: state.trustLevel,
  });
}

/**
 * Pure: return a new state with the row identified by `key` updated to have
 * the given `newEdits`, **preserving its existing `decision`**. All other
 * row fields (flags, matchedCategoryId, etc.) are preserved.
 *
 * Companion to `applyDecision`: where `applyDecision` is the TERMINAL step
 * (the row's commit decision), `updateEdits` is the INTERMEDIATE step (an
 * in-progress edit during the payee → category → memo flow, where the row
 * stays `pending` until the terminal step flips it).
 *
 * `newEdits` REPLACES the row's previous edits wholesale (no merge).
 */
export function updateEdits(
  state: ImportPreviewState,
  key: string,
  newEdits: PreviewEdits,
): ImportPreviewState {
  if (!key) {
    throw new PreviewStateError(
      PREVIEW_STATE_NOT_FOUND,
      'updateEdits requires a non-empty key',
    );
  }
  // Exactly ONE row is updated; see `applyDecision`.
  const index = state.rows.findIndex(row => rowKey(row) === key);
  if (index === -1) {
    throw new PreviewStateError(
      PREVIEW_STATE_NOT_FOUND,
      'updateEdits could not locate the row',
    );
  }
  const row = state.rows[index];
  const nextRows = [...state.rows];
  // `...row` preserves `decision` (and every other field). Only `edits` is
  // overridden. This is the whole point of the helper: mid-chain edits must
  // NOT flip the row to `accept`.
  nextRows[index] = Object.freeze({
    ...row,
    edits: freezeEdits(newEdits),
  }) as PreviewRow;
  return Object.freeze({
    rows: Object.freeze(nextRows) as readonly PreviewRow[],
    trustLevel: state.trustLevel,
  });
}

/**
 * Pure: return a new state with a different trust level.
 *
 * The trust level only feeds the gate matrix, which is applied when the
 * state is summarised. Changing it must NOT re-parse the file: the rows and
 * the user's decisions on them are still valid, and re-parsing would throw
 * the decisions away.
 */
export function withTrustLevel(
  state: ImportPreviewState,
  trustLevel: TrustLevel,
): ImportPreviewState {
  if (state.trustLevel === trustLevel) return state;
  return Object.freeze({
    rows: state.rows,
    trustLevel,
  });
}

/**
 * Pure: what the gate says about every row in the state, keyed by the row's
 * key.
 *
 * The key is the same one `rowKey` produces, so a caller can look a row's
 * evaluation up without rebuilding the key.
 *
 * It lives here rather than in `gating.ts` because it needs `rowKey`, and
 * `gating.ts` imports this module's types: keeping the dependency one way
 * avoids a cycle.
 */
export function evaluateRows(
  state: ImportPreviewState,
  opts: GateOpts = {},
): ReadonlyMap<string, RowEvaluation> {
  const evaluations = new Map<string, RowEvaluation>();
  for (const row of state.rows) {
    evaluations.set(rowKey(row), evaluateRow(row, state.trustLevel, opts));
  }
  return evaluations;
}

/**
 * Pure: return decision + gate counts.
 *
 * The two counts answer different questions and are counted separately.
 *
 * The DECISION counts (`accepted`, `dropped`, `pending`, `overridden`) say
 * what the user did. They partition the rows: a row is accepted, dropped,
 * or still pending.
 *
 * The GATE counts (`blocked`, `skipped`, `warned`) say what the trust level
 * is doing to the rows. They overlap with the decision counts on purpose: a
 * row the user accepted while the level was permissive is counted as
 * accepted AND held back when the level is raised. That overlap is the
 * point. It is what tells the user that their accept did not take effect.
 *
 * A DROPPED row is in none of the gate counts: the user threw it away,
 * which is a stronger statement than the gate.
 *
 * The gate counts are computed from the rows' EFFECTIVE flags, so a flag
 * the user has already fixed no longer holds a row back.
 *
 * The evaluations can be passed in, so a caller that already has them (the
 * UI does, for the badges) does not pay for them twice. A caller that does
 * not pass them gets the evaluations computed WITHOUT the live payee names,
 * which only matters for the `would-create-payee` flag: that flag only
 * warns, so the difference is a badge, not a transaction.
 *
 * Also returns the inflow/outflow split. Direction is derived from the
 * effective amount's SIGN, not from any stored direction field: the sign is
 * what the apply step writes to the budget.
 */
export function summarize(
  state: ImportPreviewState,
  evaluations?: ReadonlyMap<string, RowEvaluation>,
): PreviewSummary {
  const rows = evaluations ?? evaluateRows(state);

  let accepted = 0;
  let dropped = 0;
  let pending = 0;
  let overridden = 0;
  let blocked = 0;
  let skipped = 0;
  let warned = 0;
  let inflowCount = 0;
  let outflowCount = 0;

  for (const row of state.rows) {
    if (row.decision === 'accept' || row.decision === 'accept-override') {
      accepted += 1;
    } else if (row.decision === 'drop') {
      dropped += 1;
    } else {
      pending += 1;
    }

    const evaluation = rows.get(rowKey(row));
    if (!evaluation) {
      // The map covers every row of the state it was built from, so this
      // means the caller passed a map for a DIFFERENT state.
      throw new PreviewStateError(
        PREVIEW_STATE_NOT_FOUND,
        'summarize could not locate the row',
      );
    }
    const isDropped = row.decision === 'drop';

    // Only rows the gate is ACTUALLY holding back are counted, and only
    // rows that are still in the review: a dropped row was thrown away by
    // the user, which is a stronger statement than the gate.
    if (!isDropped) {
      if (evaluation.held) {
        if (evaluation.gate === 'block') blocked += 1;
        else if (evaluation.gate === 'skip') skipped += 1;
      }
      if (evaluation.gate === 'warn') warned += 1;
    }

    // An override only counts when it is in effect: a hard-blocked row the
    // user overrode is still held back, so it is counted as blocked, not as
    // overridden.
    if (evaluation.overridden && evaluation.willImport) overridden += 1;

    // Only rows that will land are counted: these numbers describe what
    // reaches the budget, not what the file contained.
    if (evaluation.willImport) {
      const cents = effectiveAmountCents(row);
      if (cents > 0) inflowCount += 1;
      else if (cents < 0) outflowCount += 1;
    }
  }

  return Object.freeze({
    total: state.rows.length,
    blocked,
    skipped,
    warned,
    accepted,
    overridden,
    dropped,
    pending,
    inflowCount,
    outflowCount,
  });
}

/**
 * What the user would lose if the review were closed.
 */
export type UnsavedWork = {
  /**
   * Whether there is anything to lose.
   *
   * The review asks before it throws anything away, and this is what says
   * whether there is anything to ask about.
   */
  hasWork: boolean;
  /** Rows the user decided: accepted, overridden or dropped. */
  decided: number;
  /** Rows the user edited. */
  edited: number;
};

/**
 * Pure: count the work the user would lose if the review were closed.
 *
 * This is what decides whether closing the review needs a confirmation, and
 * what the confirmation tells the user it would throw away. It is a
 * question about the ROWS, not about the UI: a row the user decided or
 * edited is work, and closing the review throws it away.
 *
 * What does NOT count:
 *
 *   - The trust level. It is a global view preference, not work on a row,
 *     and it is not lost by closing the review.
 *   - A row the user edited and then undid. The undo puts the row back,
 *     so there is nothing left to lose.
 *
 * An edit counts even on a row the user has not decided yet: the user
 * typed a note on that row, and closing the review throws the note away.
 *
 * An edit whose value is `undefined` does not count: `undefined` is how
 * the state says "the user has not touched this".
 */
export function unsavedWork(state: ImportPreviewState): UnsavedWork {
  let decided = 0;
  let edited = 0;

  for (const row of state.rows) {
    if (row.decision !== 'pending') decided += 1;
    if (Object.values(row.edits).some(value => value !== undefined)) {
      edited += 1;
    }
  }

  return Object.freeze({
    hasWork: decided > 0 || edited > 0,
    decided,
    edited,
  });
}
