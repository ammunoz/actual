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
  evaluateRow,
  isSplitRow,
  normalizePayeeName,
  rowKey,
  SplitValidationError,
  validateSplitRow,
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
  /**
   * The rows that are updated in place, keyed by the row's key.
   *
   * These rows are EXCLUDED from the import payload. The import's update
   * path keeps the existing payee, category and notes, so sending them
   * again would undo the edit that was just applied through
   * `transaction-update`.
   */
  updatedRowKeys?: ReadonlySet<string>;
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
 * Pure: build the `transactions-import` payload the review sends to
 * Actual's IMPORT PREVIEW.
 *
 * The preview asks Actual one question: which of these rows match a
 * transaction that is already in the budget? The answer comes back in
 * `updatedPreview`, and it is what lets a user's edit to an
 * already-imported transaction be applied in place.
 *
 * So the preview payload marks NOTHING with `skipTransaction`. Actual skips
 * a marked row BEFORE it reports the match, so a marked row would come back
 * with no correlation at all, and any later edit to it could never be
 * applied in place. The cost of sending every row is that the preview also
 * reports matches for rows the user has dropped; the review simply ignores
 * them.
 *
 * A row that is updated in place is excluded, because the import's update
 * path would undo that edit.
 */
export function buildPreviewPayload(
  state: ImportPreviewState,
  opts: BuildPayloadOpts,
): ImportReviewTransaction[] {
  return buildPayload(state, opts, { markSkipped: false });
}

/**
 * Pure: build the `transactions-import` payload the review sends when the
 * user applies the import.
 *
 * Every row is sent, including the ones that must not land. A row that will
 * not be imported is marked with `skipTransaction`, which makes Actual skip
 * it while still letting it take part in the matching pass. That matters:
 * omitting a row would change what the other rows match against, and the
 * import would not agree with the preview the user reviewed.
 *
 * A row is marked when the gate holds it back:
 *
 *   - the user dropped it,
 *   - the trust level holds it back, and the user did not override that, or
 *   - it is hard-blocked, in which case an override cannot release it
 *     either, because its data is broken.
 *
 * A row the ENGINE cannot accept is not sent at all, in either payload: a
 * row whose date the file did not supply makes the whole import throw,
 * because the matching pass does `subDays(trans.date, 7)` before it looks
 * at `skipTransaction`.
 */
export function buildApplyPayload(
  state: ImportPreviewState,
  opts: BuildPayloadOpts,
): ImportReviewTransaction[] {
  return buildPayload(state, opts, { markSkipped: true });
}

function buildPayload(
  state: ImportPreviewState,
  opts: BuildPayloadOpts,
  config: { markSkipped: boolean },
): ImportReviewTransaction[] {
  const liveCategoryIds = new Set(opts.categories.map(c => c.id));
  const updated = opts.updatedRowKeys ?? new Set<string>();
  const livePayeeNames = new Set(
    opts.payees.map(p => normalizePayeeName(p.name)),
  );

  const out: ImportReviewTransaction[] = [];

  for (const row of state.rows) {
    // A row that is updated in place is not sent to the import: the
    // import's update path would keep the existing payee, category and
    // notes and undo the edit.
    if (updated.has(rowKey(row))) continue;

    // A row the engine cannot accept is not sent AT ALL. A row whose date
    // the file did not supply makes the whole import throw, because
    // Actual's matching pass does `subDays(trans.date, 7)` before it looks
    // at `skipTransaction`. Marking the row is not enough: the throw
    // happens first.
    const evaluation = evaluateRow(row, state.trustLevel, { livePayeeNames });
    if (!evaluation.willSend) continue;

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

    // The transient row key travels with the payload so the import preview
    // echoes it back, which is how the review learns which existing
    // transaction each row matched. The leading underscore is what makes
    // Actual's insert path ignore it.
    if (row.previewKey) {
      payload._previewKey = row.previewKey;
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

    // The parent of a split has NO category: the categories live on the
    // legs, and a parent that carried one would say where the money
    // goes twice.
    //
    // Upstream's `makeChild` decides inherit-vs-override with
    // `"category" in data ? data.category : parent.category`, so a
    // parent's category is what a leg without one would inherit. A split
    // parent with no category is what makes a leg with no category land
    // uncategorized rather than in the parent's place.
    if (categoryId && !isSplitRow(row.edits)) {
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
      // The split is checked against the row it belongs to before it is
      // sent: the legs have to add up to the row's EFFECTIVE amount, and
      // the row cannot be a transfer as well.
      //
      // Upstream does NOT reject an unbalanced split: it stores it and
      // records a `SplitTransactionError` on the parent, which leaves the
      // money in no category at all. Failing loudly here is the only way
      // the user hears about it.
      //
      // The pane refuses to save an invalid split, so this can only fire
      // through a bug — and a bug that quietly unbalances a budget is
      // worse than an import that stops with a message.
      const problem = validateSplitRow(row);
      if (problem) {
        throw new SplitValidationError(
          problem.code,
          `${problem.code}: a split does not fit its row`,
        );
      }

      payload.subtransactions = row.edits.splits.map(leg => {
        // The leg's category is sent even when it is `null`: upstream's
        // `makeChild` decides inherit-vs-override with `"category" in
        // data`, so OMITTING the key makes the leg inherit the parent's
        // category. `null` says "no category" outright.
        const live =
          leg.categoryId !== undefined && liveCategoryIds.has(leg.categoryId)
            ? leg.categoryId
            : null;
        const sub: { amount: number; category: string | null } = {
          amount: leg.amountCents,
          category: live,
        };
        return sub;
      });
    }

    // A row that must not land is marked rather than omitted, so the
    // matching pass still sees it.
    if (config.markSkipped && !evaluation.willImport) {
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
  /** The key of the row this update belongs to. */
  rowKey: string;
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
 *
 * A row the gate holds back is not updated either: an update would write
 * the row the trust level is refusing to import, which would put it in the
 * budget by the back door.
 */
export function buildUpdatePayload(
  state: ImportPreviewState,
  opts: BuildUpdateOpts,
): BuildUpdateResult {
  const liveCategoryIds = new Set(opts.categories.map(c => c.id));
  const livePayeeNames = new Set(
    opts.payees.map(p => normalizePayeeName(p.name)),
  );
  const updates: PendingUpdate[] = [];

  for (const row of state.rows) {
    const key = rowKey(row);
    if (!opts.editedRowKeys.has(key)) continue;

    const transactionId = opts.matchedTransactionIds.get(key);
    // Without the matched transaction's id we cannot update it in place,
    // and forcing an add would duplicate it. Leave it to the import.
    if (!transactionId) continue;

    // The gate holds the row back, so the row does not land. Updating it
    // would put it in the budget anyway.
    const evaluation = evaluateRow(row, state.trustLevel, { livePayeeNames });
    if (!evaluation.willImport) continue;

    // What the user actually changed, compared against the original row.
    // Each edit is read into a local so the type narrows, rather than
    // being re-read with a cast.
    const editedAmount = row.edits.amountCents;
    const amountChanged =
      editedAmount !== undefined && editedAmount !== row.amountCents;
    const editedDate = row.edits.date;
    const dateChanged = editedDate !== undefined && editedDate !== row.date;
    const editedPayee = row.edits.payeeCanonical;
    const payeeChanged = editedPayee !== undefined;
    const editedCategory = row.edits.categoryId;
    const editedMemo = row.edits.memo;
    const memoChanged = editedMemo !== undefined;

    // A category the user chose that no longer exists cannot be applied.
    // If that was the only change, there is nothing to write.
    const liveCategoryId =
      editedCategory !== undefined && liveCategoryIds.has(editedCategory)
        ? editedCategory
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
      date: editedDate ?? row.date,
    };

    let payeeNameToCreate: string | undefined;

    const transferAccountId = effectiveTransferAccountId(row);
    const transferPayeeId = transferAccountId
      ? findTransferPayeeId(transferAccountId, opts.payees)
      : undefined;

    if (transferPayeeId) {
      update.payee = transferPayeeId;
    } else if (editedPayee !== undefined) {
      // The user chose a payee. If an existing payee has that name, use
      // its id; otherwise the payee has to be created first, which is the
      // caller's job.
      const payeeId = findPayeeIdByName(editedPayee, opts.payees);
      if (payeeId) {
        update.payee = payeeId;
      } else {
        payeeNameToCreate = editedPayee;
      }
    }

    if (liveCategoryId !== undefined) {
      update.category = liveCategoryId;
    }

    if (editedMemo !== undefined) {
      update.notes = editedMemo;
    }

    updates.push({
      rowKey: key,
      update,
      ...(payeeNameToCreate !== undefined && { payeeNameToCreate }),
    });
  }

  return { updates };
}
