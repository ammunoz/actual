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
 *     name-based lookup.
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
import type { ImportPreviewState } from '@actual-app/core/server/transactions/import/review/index';

import type { ImportReviewTransaction, ImportReviewUpdate } from './types';

/** A budget payee, as the payload builder needs it. */
export type ReviewPayeeRef = {
  id: string;
  name: string;
  /** Set for the hidden per-account payee Actual keeps for transfers. */
  transfer_acct?: string | null;
};

export type BuildPayloadOpts = {
  /** The budget account the rows are imported into. */
  accountId: string;
  /** Live payees, used to resolve a transfer account and a typed payee name. */
  payees: readonly ReviewPayeeRef[];
  /** Live categories, used to drop a stale category id. */
  categories: readonly { id: string }[];
};

/**
 * The transfer payee id for an account, if the budget has one. Actual keeps
 * one hidden payee per account for transfers, with `transfer_acct` set to
 * the account id.
 */
function findTransferPayeeId(
  accountId: string,
  payees: readonly ReviewPayeeRef[],
): string | undefined {
  return payees.find(p => p.transfer_acct === accountId)?.id;
}

/**
 * The id of an existing payee with this name, if there is one.
 *
 * Used to turn a payee name the user typed into a payee id, so that the
 * user's choice wins over whatever the resolver matched.
 */
function findPayeeIdByName(
  name: string,
  payees: readonly ReviewPayeeRef[],
): string | undefined {
  const lower = name.trim().toLowerCase();
  return payees.find(p => p.name.trim().toLowerCase() === lower)?.id;
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

  for (const row of state.rows) {
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

    // The payee, in precedence order:
    //
    //   1. a transfer target
    //   2. the payee the USER chose, if they chose one. This has to beat
    //      the resolver's match: `matchedPayeeId` comes from the original
    //      raw payee string and says nothing about what the user picked
    //      afterwards.
    //   3. the payee the resolver matched
    //   4. the canonical name, so Actual creates the payee
    //
    // If a transfer was detected but the budget has no transfer payee for
    // the target account, the row falls through to the name path. Actual
    // creates one payee per account, so this should not happen; when it
    // does, the row lands under the account's name, which is visible to
    // the user rather than silently mis-assigned.
    const userPayeeId =
      row.edits.payeeCanonical !== undefined
        ? findPayeeIdByName(row.edits.payeeCanonical, opts.payees)
        : undefined;

    if (transferPayeeId) {
      payload.payee = transferPayeeId;
    } else if (row.edits.payeeCanonical !== undefined) {
      if (userPayeeId) {
        payload.payee = userPayeeId;
      } else {
        // No existing payee has this name: Actual creates it.
        payload.payee_name = row.edits.payeeCanonical;
      }
    } else if (row.matchedPayeeId) {
      payload.payee = row.matchedPayeeId;
    } else if (userPayee) {
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
        const sub: { amount: number; category?: string } = {
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

export type BuildUpdateOpts = {
  /** The budget account the rows belong to. */
  accountId: string;
  /** The transaction each row matched, keyed by the row's key. */
  matchedTransactionIds: ReadonlyMap<string, string>;
  /** Live payees, used to resolve a transfer account and a typed payee name. */
  payees: readonly ReviewPayeeRef[];
  /** Live categories, used to drop a stale category id. */
  categories: readonly { id: string }[];
  /** The rows the user edited, keyed by the row's key. */
  editedRowKeys: ReadonlySet<string>;
};

export type BuildUpdateResult = {
  /** The updates to send, in row order. */
  updates: PendingUpdate[];
};

/**
 * An update that is ready to send, plus anything it is waiting on.
 */
export type PendingUpdate = {
  /** The update to send to `transaction-update`. */
  update: ImportReviewUpdate;
  /**
   * The name of a payee that has to exist before the update can be sent.
   *
   * `transaction-update` cannot create a payee from a name: `payee_name` is
   * not a column on the transaction, only the import path resolves it. So
   * when the user names a payee that does not exist yet, the caller has to
   * create it and put its id on the update.
   */
  payeeNameToCreate?: string;
};

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
 * reported.
 *
 * Only the fields the user actually changed are sent. The amount and the
 * date are always included because `transaction-update` takes a whole
 * transaction, but a row whose ONLY change is the amount still has to be
 * sent — comparing the update's own keys would drop it.
 */
export function buildUpdatePayload(
  state: ImportPreviewState,
  opts: BuildUpdateOpts,
): BuildUpdateResult {
  const liveCategoryIds = new Set(opts.categories.map(c => c.id));
  const updates: PendingUpdate[] = [];

  for (const row of state.rows) {
    const key = rowKey(row);
    if (!opts.editedRowKeys.has(key)) continue;

    const transactionId = opts.matchedTransactionIds.get(key);
    // Without the matched transaction's id we cannot update it in place,
    // and forcing an add would duplicate it. Leave it to the import.
    if (!transactionId) continue;
    if (row.decision === 'drop') continue;

    // What the user actually changed, compared against the original row.
    const amountChanged =
      row.edits.amountCents !== undefined &&
      row.edits.amountCents !== row.amountCents;
    const dateChanged =
      row.edits.date !== undefined && row.edits.date !== row.date;
    const payeeChanged = row.edits.payeeCanonical !== undefined;
    const categoryChanged = row.edits.categoryId !== undefined;
    const memoChanged = row.edits.memo !== undefined;

    // A category the user chose that no longer exists cannot be applied.
    // If that was the only change, there is nothing to write.
    const liveCategoryId =
      categoryChanged && liveCategoryIds.has(row.edits.categoryId as string)
        ? (row.edits.categoryId as string)
        : undefined;

    const hasChange =
      amountChanged ||
      dateChanged ||
      payeeChanged ||
      liveCategoryId !== undefined ||
      memoChanged;
    if (!hasChange) continue;

    const update: ImportReviewUpdate = {
      id: transactionId,
      account: opts.accountId,
      amount: effectiveAmountCents(row),
      date: row.edits.date ?? row.date,
    };

    let payeeNameToCreate: string | undefined;

    const transferAccountId = effectiveTransferAccountId(row);
    const transferPayeeId = transferAccountId
      ? findTransferPayeeId(transferAccountId, opts.payees)
      : undefined;

    if (transferPayeeId) {
      update.payee = transferPayeeId;
    } else if (payeeChanged) {
      // The user chose a payee. If an existing payee has that name, use
      // its id; otherwise the payee has to be created first, which is the
      // caller's job.
      const payeeId = findPayeeIdByName(
        row.edits.payeeCanonical as string,
        opts.payees,
      );
      if (payeeId) {
        update.payee = payeeId;
      } else {
        payeeNameToCreate = row.edits.payeeCanonical;
      }
    }

    if (liveCategoryId !== undefined) {
      update.category = liveCategoryId;
    }

    if (memoChanged) {
      update.notes = row.edits.memo;
    }

    updates.push({
      update,
      ...(payeeNameToCreate !== undefined && { payeeNameToCreate }),
    });
  }

  return { updates };
}
