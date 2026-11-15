/**
 * Reconciles a SPLIT that is already in the budget.
 *
 * A split row is sent to Actual's import as a parent plus its legs, and
 * the import's INSERT path creates them. The UPDATE path does not: it
 * writes columns on the parent it matched, and never touches the legs. So
 * re-importing a file whose row the user split leaves the OLD legs in
 * place, and the user's new split is dropped.
 *
 * Upstream's own API solves this with a diff-based update, but the desktop
 * client cannot call the API handlers. Upstream's own desktop UI solves it
 * by editing the split client-side and sending the difference, and that is
 * what this does — with upstream's OWN helpers, so the bookkeeping (a
 * child's account, date and cleared flag come from its parent) stays
 * upstream's business.
 *
 * The legs are matched to the existing legs IN ORDER: the first leg is the
 * first leg, the second is the second, and so on. A leg that is there
 * already is updated rather than replaced, so anything the user put on it
 * — a note, a cleared flag — survives. A leg that is new is created, and a
 * leg that is gone is deleted.
 */

import type { PreviewSplitLeg } from '@actual-app/core/server/transactions/import/review/index';
import { makeChild } from '@actual-app/core/shared/transactions';
import type { TransactionEntity } from '@actual-app/core/types/models';

/**
 * A transaction that has to change.
 *
 * `category` is nullable here even though the entity type does not say
 * so: a leg with no category has to CLEAR the category, and the column is
 * nullable. Upstream's own code sends `category: null` for the same
 * reason (`useTransactionBatchActions`).
 */
export type SplitTransactionUpdate = Omit<
  Partial<TransactionEntity>,
  'category'
> & {
  category?: string | null;
};

/**
 * What has to change for a split to become the legs the review wants.
 *
 * The shape is the one `transactions-batch-update` takes.
 */
export type SplitReconciliation = {
  /** The legs that have to be created. */
  added: TransactionEntity[];
  /** The transactions that have to change: the legs and the parent. */
  updated: SplitTransactionUpdate[];
  /** The legs that have to go. */
  deleted: { id: string }[];
};

/**
 * The legs of a split, in the order they are shown.
 *
 * `sort_order` is what puts them in order, and it is a float that counts
 * DOWN: a leg added later sorts before the ones that were there before.
 */
function bySortOrder(
  a: Pick<TransactionEntity, 'sort_order'>,
  b: Pick<TransactionEntity, 'sort_order'>,
): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0);
}

/**
 * Pure: what has to change for a split to become these legs.
 *
 * `parent` is the transaction the row matched, and `children` are the legs
 * it has now — none at all when the transaction is not a split yet.
 */
export function buildSplitReconciliation(opts: {
  /** The transaction the row matched. */
  parent: TransactionEntity;
  /** The legs it has now. */
  children: readonly TransactionEntity[];
  /** The legs the review wants. */
  legs: readonly PreviewSplitLeg[];
}): SplitReconciliation {
  const { parent, legs } = opts;
  const children = [...opts.children].sort(bySortOrder);

  const added: TransactionEntity[] = [];
  const updated: SplitTransactionUpdate[] = [];
  const deleted: { id: string }[] = [];

  legs.forEach((leg, index) => {
    const existing = children[index];
    // A leg without a category says so outright. Upstream's `makeChild`
    // decides inherit-vs-override with `"category" in data`, so leaving
    // the key out would make the leg inherit the parent's category — and
    // a split parent's category is nothing.
    const data = {
      amount: leg.amountCents,
      category: leg.categoryId ?? null,
      sort_order: existing?.sort_order ?? -(index + 1),
    };

    if (!existing) {
      added.push(makeChild(parent, data));
      return;
    }
    updated.push({ id: existing.id, ...data });
  });

  // The legs that are gone: the review has fewer legs than the budget.
  children.slice(legs.length).forEach(child => {
    deleted.push({ id: child.id });
  });

  // The parent itself. A split's parent has no category of its own — the
  // legs carry them — and its amount is the sum of the legs. The error
  // field is cleared: a parent whose legs did not add up is marked with
  // one, and the review has just made them add up.
  const amount = legs.reduce((total, leg) => total + leg.amountCents, 0);
  updated.push({
    id: parent.id,
    amount,
    is_parent: true,
    category: null,
    error: null,
  });

  return { added, updated, deleted };
}

/**
 * Pure: the legs of a transaction, taken from a list of transactions.
 *
 * A leg is a transaction whose `parent_id` points at the parent. The list
 * is a flat list of transactions, so the legs are picked out of it.
 */
export function childrenOf(
  transactions: readonly TransactionEntity[],
  parentId: string,
): TransactionEntity[] {
  return transactions.filter(transaction => transaction.parent_id === parentId);
}
