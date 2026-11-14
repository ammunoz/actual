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
    category?: string;
    notes?: string;
  }>;
  /**
   * Set on a row the user explicitly dropped. The row is still sent so it
   * keeps participating in Actual's matching pass — omitting it entirely
   * would let a later row match against it and change the outcome.
   */
  skipTransaction?: boolean;
  /**
   * Set on a row whose payee or category the user explicitly changed.
   *
   * Actual's update path uses `existing.payee || trans.payee`, so on a
   * re-import of an already-applied transaction the *existing* value wins
   * and the user's edit would be discarded. Forcing the add path makes
   * the user's value the one that is written.
   */
  forceAddTransaction?: boolean;
};

/**
 * How a row is presented in the review list.
 */
export type ReviewRowStatus = 'pending' | 'accept' | 'drop';

/**
 * The synced preference that gates the whole feature.
 *
 * `SyncedPrefs` has a catch-all `| string`, so this key needs no change to
 * upstream's preference types.
 */
export const KEYBOARD_MODE_PREF = 'import-review.keyboard-mode';

/**
 * The synced preference that holds the vendor dictionary.
 */
export const VENDOR_MAP_PREF = 'import-review.vendor-map';
