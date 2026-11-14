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

import { gateByTrustLevel } from '#server/transactions/import/review/resolver/flags';
import type {
  ResolvedRow,
  TrustLevel,
} from '#server/transactions/import/review/types';

import type { PreviewSplitLeg } from './split-primitives';

export type PreviewDecision = 'pending' | 'accept' | 'drop';

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
   * User-assigned budget category id. `undefined` means the user has not
   * picked one; the apply step omits the category and Actual's rules pick
   * whatever default applies.
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
  blocked: number;
  skipped: number;
  warned: number;
  accepted: number;
  dropped: number;
  pending: number;
  /**
   * Rows that will land as money IN (inflow), and as money OUT.
   *
   * Counting basis is accept + pending — dropped rows are excluded, so these
   * two numbers describe the transactions that will actually reach the
   * budget, not the contents of the file. They therefore move as the user
   * accepts/drops, which is what makes the pair complementary to
   * `accepted` / `dropped` / `pending` rather than a restatement of
   * `total`.
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
 * Pure: return decision + trust-bucket counts.
 *
 * Decisions are counted per row. Buckets are computed via `gateByTrustLevel`
 * against the rows' current flag set; an accepted row's flags still count
 * toward buckets (the user accepted the resolution, not the flag itself).
 *
 * Also returns the inflow/outflow split. Direction is derived from the
 * effective amount's SIGN, not from any stored direction field: the sign is
 * what the apply step writes to the budget.
 */
export function summarize(state: ImportPreviewState): PreviewSummary {
  let accepted = 0;
  let dropped = 0;
  let pending = 0;
  let inflowCount = 0;
  let outflowCount = 0;
  const allRows: ResolvedRow[] = [];
  for (const row of state.rows) {
    if (row.decision === 'accept') accepted += 1;
    else if (row.decision === 'drop') dropped += 1;
    else pending += 1;
    // Dropped rows are excluded: these counts describe what will land in the
    // budget, not what the file contained.
    if (row.decision !== 'drop') {
      const cents = effectiveAmountCents(row);
      if (cents > 0) inflowCount += 1;
      else if (cents < 0) outflowCount += 1;
    }
    allRows.push(row);
  }
  const gate = gateByTrustLevel(allRows, state.trustLevel);
  return Object.freeze({
    total: allRows.length,
    blocked: gate.blocked.length,
    skipped: gate.skipped.length,
    warned: gate.warned.length,
    accepted,
    dropped,
    pending,
    inflowCount,
    outflowCount,
  });
}
