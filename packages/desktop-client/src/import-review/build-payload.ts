/**
 * Builds the payload that `transactions-import` receives.
 *
 * This is the single place where the review state becomes an Actual API
 * payload, so every constraint about that API is encoded here rather than
 * scattered across the UI:
 *
 *   - `imported_id` is carried byte-for-byte. It is the dedup key.
 *   - `imported_payee` carries the RAW vendor string, so the user sees what
 *     the bank said and Actual's rule engine (which is keyed on
 *     `imported_payee`) matches against what the bank said.
 *   - `payee` carries the resolved payee ID. It overrides Actual's own
 *     name-based lookup, so the payee we resolved is the payee that lands.
 *   - `payee_name` is sent ONLY when we have no payee id, because it is the
 *     only way Actual will create a payee (`resolvePayee` looks the name up
 *     and creates it when the id is absent). When we DO have an id, sending
 *     a name too is redundant.
 *   - A dropped duplicate is sent with `skipTransaction`, not omitted, so it
 *     keeps taking part in Actual's matching pass. Omitting it would let a
 *     later row match against it and change the outcome.
 *   - A row the user edited is NOT sent with `forceAddTransaction`. That flag
 *     routes the row down Actual's ADD path, which creates a SECOND
 *     transaction rather than updating the first. It is how Actual's own
 *     import modal implements "keep both the old and the new transaction",
 *     so it is the wrong tool for "change this transaction's payee".
 *
 *     On the UPDATE path Actual computes `payee: existing.payee ||
 *     trans.payee` and `category: existing.category || trans.category`, so
 *     the EXISTING value wins and the incoming one is discarded. A user's
 *     edit to an already-imported transaction therefore cannot be honoured
 *     through `transactions-import` at all.
 *
 *     The review handles that case separately: the import preview reports
 *     which transaction each row matched, and a row the user edited is
 *     updated directly through `transaction-update`, using that id. See
 *     `buildUpdatePayload`.
 *
 * Pure: it takes the review state and the budget's payee/category lists and
 * returns payloads. No I/O, no React.
 */

import {
  effectiveAmountCents,
  effectiveTransferAccountId,
  isSplitRow,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  ImportPreviewState,
  PreviewRow,
} from '@actual-app/core/server/transactions/import/review/index';

import type { ImportReviewTransaction, ImportReviewUpdate } from './types';

export type BuildPayloadOpts = {
  /** The budget account the rows are imported into. */
  accountId: string;
  /** Live payees, used to resolve a transfer account to its transfer payee. */
  payees: readonly { id: string; transfer_acct?: string | null }[];
  /** Live categories, used to drop a stale category id. */
  categories: readonly { id: string }[];
  /**
   * The transaction each row matched, keyed by the row's key. This is what
   * the import preview reports.
   */
  matchedTransactionIds?: ReadonlyMap<string, string>;
};

/**
 * The transfer payee id for an account, if the budget has one. Actual keeps
 * one hidden payee per account for transfers, with `transfer_acct` set to
 * the account id.
 */
function findTransferPayeeId(
  accountId: string,
  payees: readonly { id: string; transfer_acct?: string | null }[],
): string | undefined {
  return payees.find(p => p.transfer_acct === accountId)?.id;
}

/**
 * Pure: build the `transactions-import` payload for the review's rows.
 *
 * Rows that are still pending are included: they are what the user has not
 * yet rejected, and the apply step is the terminal decision point. Rows the
 * user dropped are sent with `skipTransaction` so Actual's matching is
 * unaffected.
 */
export function buildImportPayload(
  state: ImportPreviewState,
  opts: BuildPayloadOpts,
): ImportReviewTransaction[] {
  const liveCategoryIds = new Set(opts.categories.map(c => c.id));

  const out: ImportReviewTransaction[] = [];

  for (const row of state.rows as readonly PreviewRow[]) {
    const isDropped = row.decision === 'drop';

    // The payee the user ended up with. A transfer target wins over the
    // ordinary payee: a transfer row is not a payee row.
    const transferAccountId = effectiveTransferAccountId(row);
    const transferPayeeId = transferAccountId
      ? findTransferPayeeId(transferAccountId, opts.payees)
      : undefined;

    // The name to create the payee with, when we do not have an id for it.
    const userPayee = row.edits.payeeCanonical ?? row.payeeCanonical;

    // A stale category id is dropped rather than sent: the apply step is
    // the only component that knows which ids are live.
    const categoryId =
      row.edits.categoryId !== undefined
        ? liveCategoryIds.has(row.edits.categoryId)
          ? row.edits.categoryId
          : undefined
        : row.matchedCategoryId && liveCategoryIds.has(row.matchedCategoryId)
          ? row.matchedCategoryId
          : undefined;

    const payload: ImportReviewTransaction = {
      account: opts.accountId,
      date: row.edits.date ?? row.date,
      amount: effectiveAmountCents(row),
      imported_payee: row.payeeRaw,
      cleared: true,
    };

    if (row.importedId) {
      payload.imported_id = row.importedId;
    }

    if (transferPayeeId) {
      payload.payee = transferPayeeId;
    } else if (row.matchedPayeeId) {
      payload.payee = row.matchedPayeeId;
    } else if (userPayee) {
      // No existing payee matched: Actual creates one from the name.
      payload.payee_name = userPayee;
    }

    if (categoryId) {
      payload.category = categoryId;
    }

    if (row.edits.memo !== undefined) {
      payload.notes = row.edits.memo;
    } else if (row.memo) {
      payload.notes = row.memo;
    }

    // A split carries its categories on the legs. The parent keeps the
    // payee, date, imported_id and notes; the categories live on the legs.
    if (isSplitRow(row.edits) && row.edits.splits) {
      payload.subtransactions = row.edits.splits.map(leg => {
        const sub: { amount: number; category?: string; notes?: string } = {
          amount: leg.amountCents,
        };
        if (leg.categoryId && liveCategoryIds.has(leg.categoryId)) {
          sub.category = leg.categoryId;
        }
        return sub;
      });
    }

    if (isDropped) {
      payload.skipTransaction = true;
    }

    out.push(payload);
  }

  return out;
}

/**
 * Pure: build the direct updates for the rows the user edited and that
 * matched an existing transaction.
 *
 * Actual's import UPDATE path computes `payee: existing.payee ||
 * trans.payee` and `category: existing.category || trans.category`, so the
 * existing value wins and the user's edit is discarded. `forceAddTransaction`
 * does not help either: it routes the row down the ADD path and creates a
 * SECOND transaction.
 *
 * So a user's edit to an already-imported transaction is applied directly,
 * through `transaction-update`, using the transaction id the import preview
 * reported. Only the fields the user actually changed are sent, so the
 * update touches nothing else.
 */
export function buildUpdatePayload(
  state: ImportPreviewState,
  opts: {
    /** The budget account the rows belong to. */
    accountId: string;
    /** The transaction each row matched, keyed by the row's key. */
    matchedTransactionIds: ReadonlyMap<string, string>;
    /** Live payees, used to resolve a transfer account to its transfer payee. */
    payees: readonly { id: string; transfer_acct?: string | null }[];
    /** Live categories, used to drop a stale category id. */
    categories: readonly { id: string }[];
    /** The rows the user edited, keyed by the row's key. */
    editedRowKeys: ReadonlySet<string>;
  },
): ImportReviewUpdate[] {
  const liveCategoryIds = new Set(opts.categories.map(c => c.id));
  const out: ImportReviewUpdate[] = [];

  for (const row of state.rows as readonly PreviewRow[]) {
    const key = rowKey(row);
    if (!opts.editedRowKeys.has(key)) continue;

    const transactionId = opts.matchedTransactionIds.get(key);
    // Without the matched transaction's id we cannot update it in place,
    // and forcing an add would duplicate it. Leave it to the import.
    if (!transactionId) continue;
    if (row.decision === 'drop') continue;

    // `transaction-update` takes a whole transaction, so the fields the
    // user did NOT change are sent as they are.
    const update: ImportReviewUpdate = {
      id: transactionId,
      account: opts.accountId,
      amount: effectiveAmountCents(row),
      date: row.edits.date ?? row.date,
    };

    const transferAccountId = effectiveTransferAccountId(row);
    const transferPayeeId = transferAccountId
      ? findTransferPayeeId(transferAccountId, opts.payees)
      : undefined;

    if (transferPayeeId) {
      update.payee = transferPayeeId;
    } else if (row.edits.payeeCanonical !== undefined && row.matchedPayeeId) {
      update.payee = row.matchedPayeeId;
    }

    if (row.edits.categoryId !== undefined) {
      if (liveCategoryIds.has(row.edits.categoryId)) {
        update.category = row.edits.categoryId;
      }
    }

    if (row.edits.memo !== undefined) {
      update.notes = row.edits.memo;
    }

    // Only the fields the user actually changed are sent, on top of the
    // ones `transaction-update` requires.
    const changed = Object.keys(update).filter(
      k => k !== 'id' && k !== 'account' && k !== 'amount' && k !== 'date',
    );
    if (changed.length === 0) continue;

    out.push(update);
  }

  return out;
}
