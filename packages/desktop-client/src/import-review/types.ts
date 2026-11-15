/**
 * Client-side types for the import-review feature.
 *
 * The domain types (flags, rows, resolver results) live in the core layer
 * and are re-exported here so the UI imports from one place. This file adds
 * only the types that are genuinely client-side: the shape of the apply
 * payload and the review UI's own state.
 */

import type {
  Flag,
  FlagCode,
  FlagKind,
  PayeeMatchSource,
  ResolvedRow,
  ReviewAccount,
  ReviewCategory,
  ReviewPayee,
  ReviewPayeeRule,
  ReviewRowInput,
  TrustLevel,
  VendorMap,
} from '@actual-app/core/server/transactions/import/review/index';

export type {
  Flag,
  FlagCode,
  FlagKind,
  PayeeMatchSource,
  ResolvedRow,
  ReviewAccount,
  ReviewCategory,
  ReviewPayee,
  ReviewPayeeRule,
  ReviewRowInput,
  TrustLevel,
  VendorMap,
};

/**
 * The payload for a single row, as `transactions-import` expects it.
 *
 * This mirrors Actual's `ImportTransactionEntity` plus the two flags
 * (`skipTransaction`, `forceAddTransaction`) that Actual's own import modal
 * sets on the object even though the type does not declare them.
 *
 * On `payee_name`: Actual's `normalizeTransactions` strips `payee_name`
 * from the transaction object before the rule engine runs, so it never
 * reaches the rules as a field. Its only remaining effect is to be the name
 * `resolvePayee` looks up — and creates — when the transaction carries no
 * payee id. So we send it ONLY in that case. When we already resolved a
 * payee id, `payee` wins and the name is redundant.
 */
export type ImportReviewTransaction = {
  account: string;
  date: string;
  amount: number;
  imported_id?: string;
  imported_payee?: string;
  /**
   * A transient key that identifies this row inside the review.
   *
   * It is sent so the import preview echoes it back, which is how the
   * review learns which existing transaction each row matched.
   *
   * The leading underscore is load-bearing: Actual's insert path runs
   * every field through `conform`, which THROWS on a field the
   * transactions table does not have. Fields that start with an underscore
   * are the ones it ignores, so that is how a transient field is passed
   * through without being written.
   */
  _previewKey?: string;
  payee?: string | null;
  /**
   * Only sent when no payee id is known, so that Actual creates the payee.
   */
  payee_name?: string;
  category?: string;
  notes?: string;
  cleared?: boolean;
  subtransactions?: Array<{
    amount: number;
    /**
     * The leg's category id, or `null` for a leg that has none.
     *
     * `null` and "omitted" are NOT the same thing: upstream's
     * `makeChild` decides inherit-vs-override with
     * `"category" in data ? data.category : parent.category`, so a leg
     * without the key INHERITS the parent's category. `null` says "no
     * category" outright, which is what a leg without one means.
     */
    category?: string | null;
  }>;
  /**
   * Set on a row the user explicitly dropped. The row is still sent so it
   * keeps participating in Actual's matching pass — omitting it entirely
   * would let a later row match against it and change the outcome.
   */
  skipTransaction?: boolean;
};

/**
 * A direct update to a transaction that already exists in the budget.
 *
 * Sent through `transaction-update` rather than `transactions-import`,
 * because Actual's import UPDATE path prefers the existing value
 * (`existing.payee || trans.payee`) and would discard the user's edit.
 *
 * `transaction-update` takes a `TransactionEntity`, but the server only
 * reads `id`, `payee`, `category`, `amount`, `date` and `notes` from it,
 * so the remaining fields are sent as the transaction already had them:
 * the account, and the amount and date the user did NOT change.
 */
export type ImportReviewUpdate = {
  /** The transaction to update. */
  id: string;
  /** The account the transaction belongs to. */
  account: string;
  /** The amount, in integer cents. */
  amount: number;
  /** The date, `YYYY-MM-DD`. */
  date: string;
  payee?: string;
  category?: string;
  notes?: string;
};

/**
 * How a row is presented in the review list.
 */
export type ReviewRowStatus = 'pending' | 'accept' | 'accept-override' | 'drop';

/**
 * The synced preference that gates the whole feature.
 *
 * `SyncedPrefs` does NOT have a catch-all: `keyof` collapses to the literal
 * union of the known keys, so this key needs `useCustomSyncedPref` rather
 * than `useSyncedPref`, and no change to upstream's preference types.
 */
export const KEYBOARD_MODE_PREF = 'import-review.keyboard-mode';

/**
 * The synced preference that holds the vendor dictionary.
 */
export const VENDOR_MAP_PREF = 'import-review.vendor-map';
