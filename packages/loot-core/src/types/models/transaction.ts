import type { IntegerAmount } from '#shared/util';

import type { AccountEntity } from './account';
import type { CategoryEntity } from './category';
import type { PayeeEntity } from './payee';
import type { ScheduleEntity } from './schedule';

/**
 * A rule that fired while a transaction was being prepared, and the
 * transaction fields it set.
 *
 * `fields` is the set of fields the rule's ACTIONS target — not the ones
 * whose value happened to change. A rule that sets the category to the
 * value the transaction already had still CONTROLS the category: an edit
 * to it would be discarded when the rule runs again, so a caller that
 * shows the user what a rule controls has to know about it.
 */
export type AppliedRule = {
  /**
   * The rule's id.
   *
   * Every rule that runs comes from the budget's rule table, so it has
   * one. It is empty only for a rule built without one, which the import
   * never sees.
   */
  id: string;
  /**
   * The transaction fields the rule set.
   *
   * A split action is NOT here: it sets the field on a leg of the split,
   * not on the transaction itself. The fields are named as the TRANSACTION
   * names them — a rule that sets the payee by name sets `payee`.
   */
  fields: string[];
};

export type TransactionEntity = {
  id: string;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: TransactionEntity['id'];
  account: AccountEntity['id'];
  category?: CategoryEntity['id'];
  amount: IntegerAmount;
  payee?: PayeeEntity['id'] | null;
  notes?: string;
  date: string;
  imported_id?: string;
  imported_payee?: string;
  starting_balance_flag?: boolean;
  transfer_id?: TransactionEntity['id'];
  sort_order?: number;
  cleared?: boolean;
  reconciled?: boolean;
  tombstone?: boolean;
  forceUpcoming?: boolean;
  schedule?: ScheduleEntity['id'];
  subtransactions?: TransactionEntity[];
  _unmatched?: boolean;
  _deleted?: boolean;
  error?: {
    type: 'SplitTransactionError';
    version: 1;
    difference: number;
  } | null;
  raw_synced_data?: string | undefined;
  _ruleErrors?: string[];
  /**
   * The rules that fired while this transaction was prepared, and the
   * fields they set.
   *
   * The field starts with an underscore, like `_ruleErrors`, so the
   * insert path ignores it: `conform` skips every field that starts with
   * one, so this never reaches the `transactions` table.
   */
  _appliedRules?: AppliedRule[];
  /**
   * Set when a transfer row could match more than one existing mirror, so
   * the review can warn instead of letting the import guess. Like
   * `_appliedRules`, the underscore makes `conform` skip it on insert.
   */
  _ambiguousTransfer?: boolean;
};

/**
 * A transaction as the import engine worked on it — before anything was
 * written, so it has no id yet.
 *
 * The import mints the id later, on the insert path. A caller that reads
 * a transaction out of the import's preview must not expect one.
 */
export type PreviewTransaction = Omit<TransactionEntity, 'id'> & {
  id?: undefined;
};
