/**
 * Public type surface for the import-review domain layer.
 *
 * Everything here is pure data: no React, no filesystem, no database, no
 * `send()`. The layer is deliberately free of Actual's runtime so that the
 * whole review workflow can be exercised against fixtures.
 *
 * The boundary is one-way. Actual's own types (`PayeeEntity`, `AccountEntity`,
 * `CategoryEntity`) are accepted as *inputs* to the resolver and are
 * translated into the local shapes below; the local shapes are what the
 * review state and the apply payload are built from. Actual never sees these
 * types.
 */

/**
 * Trust level, inherited from the TUI implementation. Controls how harshly
 * a flag is treated:
 *
 *   `paranoid`  a single blocking flag prevents the row from being applied
 *   `cautious`  blocking flags still block; duplicates are skipped instead
 *   `trusted`   blocking flags degrade to warnings
 */
export type TrustLevel = 'paranoid' | 'cautious' | 'trusted';

/**
 * The kinds of problem that can be attached to a row. Generic across
 * vendors — no bank-specific labels.
 */
export type FlagKind =
  | 'duplicate'
  | 'unknown-payee'
  | 'amount-mismatch'
  | 'date-out-of-range'
  | 'fuzzy-payee-match'
  | 'would-create-payee'
  | 'transfer-detected';

/**
 * Stable, greppable codes for flags. Deliberately value-free: a code
 * identifies a *class* of problem and never encodes a payee name, an
 * amount, or any other user data.
 */
export type FlagCode =
  | 'FITID-DUP-001'
  | 'FITID-DUP-002'
  | 'PAYEE-UNK-001'
  | 'AMT-MISMATCH-001'
  | 'DATE-RANGE-001'
  | 'DATE-RANGE-002'
  | 'PAYEE-FUZZY-001'
  | 'PAYEE-NEW-001'
  | 'PAYEE-TRANSFER-001';

export type Flag = {
  kind: FlagKind;
  code: FlagCode;
  /**
   * Optional context. Never a user-visible value: callers pass things like
   * `score=0.82` or `canonical=<name>`, never the name itself.
   */
  note?: string;
};

/**
 * A row as it arrives from Actual's file parser, normalized into the shape
 * the review layer works with.
 *
 * `importedId` is the bank's transaction id (FITID). It is the dedup key
 * Actual's reconciliation engine uses, and it is carried byte-for-byte —
 * never re-encoded, trimmed, or case-folded.
 */
export type ReviewRowInput = {
  /** Budget account the row will be imported into. */
  accountId: string;
  /** The bank's transaction id (FITID). May be absent for some files. */
  importedId?: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed integer cents. Negative for money out. */
  amountCents: number;
  /** The raw vendor string exactly as the bank supplied it. */
  payeeRaw: string;
  /** Bank-supplied memo, if any. */
  memo?: string;
  /** Category id supplied by the file, if any. */
  categoryId?: string;
  /**
   * Transient correlation key used to line a row up with its preview entry.
   * Assigned by the caller; never persisted.
   */
  previewKey?: string;
  /** Flags detected during parsing (e.g. duplicate FITIDs). */
  flags?: readonly Flag[];
};

/**
 * A budget payee, reduced to what the resolver needs. `transferAcct` is set
 * for the hidden per-account payee Actual keeps for transfers; those are
 * excluded from prefix and fuzzy matching so a vendor string can never
 * fuzzy-match its way into becoming a transfer.
 */
export type ReviewPayee = {
  id: string;
  name: string;
  /**
   * The account this payee is the transfer payee for, or null/undefined for
   * an ordinary payee.
   *
   * Actual's `payees` column is nullable and the API returns `null` for an
   * ordinary payee, so this has to accept `null` — a check for `undefined`
   * alone would treat every ordinary payee as a transfer payee.
   */
  transferAcct?: string | null;
};

/** A budget account, reduced to what the resolver and the UI need. */
export type ReviewAccount = {
  id: string;
  name: string;
  offbudget?: boolean;
  closed?: boolean;
};

/** A budget category, reduced to what the UI needs. */
export type ReviewCategory = {
  id: string;
  name: string;
  groupName?: string;
  hidden?: boolean;
  isIncome?: boolean;
};

/**
 * Where a row's payee came from. Ordered by the resolver's layer priority.
 */
export type PayeeMatchSource =
  | 'vendor-map'
  | 'existing-prefix'
  | 'fuzzy'
  | 'strip-fallback'
  | 'transfer'
  | 'none';

/**
 * The per-budget dictionary of confirmed raw-vendor-name → payee id
 * mappings. Layer 0 of the resolver: an explicit user confirmation always
 * wins over a heuristic.
 */
export type VendorMap = {
  v: 1;
  /** Most recent mutation timestamp (ISO-8601 UTC). */
  updatedAt: string;
  /** Key: raw imported payee name; value: budget payee id. */
  entries: Readonly<Record<string, string>>;
};

/**
 * A row after payee resolution. Carries the original row plus what the
 * resolver decided.
 */
export type ResolvedRow = ReviewRowInput & {
  /** The payee name to use. Empty when the resolver found nothing. */
  payeeCanonical: string;
  /** Which resolver layer produced the match. */
  payeeMatchSource: PayeeMatchSource;
  /**
   * Budget payee id, when the match came from the budget's payee list
   * (vendor map, prefix, fuzzy). Undefined for the strip fallback and
   * for no match at all, which produce a synthetic name.
   */
  matchedPayeeId?: string;
  /**
   * Budget account id, when the row was detected as an inter-account
   * transfer. The transfer is a default: it applies unless the user gives
   * the row a payee or takes the transfer away.
   */
  matchedTransferAccountId?: string;
  /** Flags attached during resolution. */
  flags: readonly Flag[];
};
