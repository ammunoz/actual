/**
 * Finds the transactions that are ALREADY in the budget.
 *
 * The review has to know which of its rows correspond to a transaction the
 * budget already holds, because Actual's import UPDATE path keeps the
 * existing value (`existing.payee || trans.payee`) and throws the user's
 * edit away. A row that is already in the budget is therefore updated
 * directly, through `transaction-update`, and the transaction's id is what
 * makes that possible.
 *
 * The obvious way to learn that is to ask the import preview, and the
 * review used to do exactly that. It does not work:
 *
 *   Upstream's preview reports the matched transaction ONLY when the
 *   matched row's fields DIFFER from it
 *   (`packages/loot-core/src/server/accounts/sync.ts`: a match whose
 *   fields did not change is reported as `{ ignored: true }`, with no
 *   `existing` at all).
 *
 * A file that is imported a second time matches its own transactions
 * exactly, so the preview reports nothing — and every feature that
 * depended on the preview's answer silently did nothing. A user's edit to
 * an already-imported transaction was discarded, and the review said the
 * import succeeded.
 *
 * So the review asks the budget DIRECTLY, using the FITID — the bank's own
 * transaction id — which is the key Actual's matching pass uses first
 * (`SELECT * FROM v_transactions WHERE imported_id = ? AND account = ?`).
 *
 * The account is part of the question, not an afterthought: a FITID is
 * only unique WITHIN an account, and a transaction in another account
 * that happens to share a FITID is a different transaction entirely.
 * Matching it would edit the wrong row. So the lookup is scoped to the
 * account the rows go into, and each row is matched against its OWN
 * account.
 *
 * This file is the only place in the feature that knows how that question
 * is asked. The mapping from a transaction id to the rows it belongs to is
 * pure, so it can be tested without a budget.
 */

import { rowKey } from '@actual-app/core/server/transactions/import/review/index';
import { q } from '@actual-app/core/shared/query';

import { aqlQuery } from '#queries/aqlQuery';

/**
 * A row of the review, as far as the lookup is concerned.
 */
export type LookupRow = {
  /** The bank's transaction id, when the file supplied one. */
  importedId?: string | undefined;
  /** The row's key inside the review. */
  previewKey?: string | undefined;
  /**
   * The account the row is imported into.
   *
   * A FITID is only unique within an account, so the match is made
   * against the row's OWN account and never against another's.
   */
  accountId?: string | undefined;
};

/**
 * The transactions the budget already holds, keyed by the account and then
 * by the FITID that found them.
 *
 * A FITID that appears on more than one transaction keeps the FIRST one,
 * which is the row upstream's matching pass takes as well (it selects a
 * single row with `db.first`).
 */
export type ImportedTransactions = ReadonlyMap<
  string,
  ReadonlyMap<string, string>
>;

/**
 * Ask the budget which transactions already carry one of these FITIDs.
 *
 * The query is scoped to the accounts on purpose: a FITID is only unique
 * WITHIN an account, and a transaction in another account that happens to
 * share a FITID is a different transaction entirely. Matching it would
 * edit the wrong row.
 *
 * An empty list of FITIDs means the file supplied none, and there is
 * nothing to ask: no query is sent.
 */
export async function findImportedTransactions(opts: {
  /** The account the rows go into. */
  accountId: string;
  /** The FITIDs the file supplied. */
  importedIds: readonly string[];
}): Promise<ImportedTransactions> {
  const ids = [...new Set(opts.importedIds.filter(id => id.length > 0))];
  const accounts = opts.accountId ? [opts.accountId] : [];
  if (ids.length === 0 || accounts.length === 0) return new Map();

  const { data } = await aqlQuery(
    q('transactions')
      .filter({ account: { $oneof: accounts }, imported_id: { $oneof: ids } })
      .select(['id', 'imported_id', 'account']),
  );

  const found = new Map<string, Map<string, string>>();
  // The query's own type is `any`, so the rows are narrowed here rather
  // than trusted.
  const rows: unknown[] = Array.isArray(data) ? data : [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { id, imported_id: importedId, account } = row;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof importedId !== 'string' || importedId.length === 0) continue;
    if (typeof account !== 'string' || account.length === 0) continue;
    // The first transaction wins, the same way upstream's matching pass
    // takes the first row with that imported id.
    const forAccount = found.get(account) ?? new Map<string, string>();
    if (!forAccount.has(importedId)) {
      forAccount.set(importedId, id);
    }
    found.set(account, forAccount);
  }
  return found;
}

/**
 * Narrow a value to a record, so its fields can be read one at a time.
 *
 * The query's own type is `any`, so the rows it returns are checked here
 * rather than trusted.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Pure: the transaction each row is already in the budget as, keyed by the
 * row's key.
 *
 * A FITID that appears on MORE THAN ONE row of the file is ambiguous: both
 * rows would point at the same transaction, and updating it once per row
 * would apply the second row's edits to the first row's transaction. Such a
 * row is left unmatched, so it goes through the import the ordinary way.
 *
 * The ambiguity is per ACCOUNT: two rows with the same FITID in two
 * different accounts are two different transactions, and neither is
 * ambiguous.
 */
export function matchRowsToTransactions(
  rows: readonly LookupRow[],
  imported: ImportedTransactions,
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.importedId) continue;
    const key = ambiguityKey(row.accountId, row.importedId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const matched = new Map<string, string>();
  for (const row of rows) {
    const importedId = row.importedId;
    if (!importedId) continue;
    if (counts.get(ambiguityKey(row.accountId, importedId)) !== 1) continue;
    const transactionId = imported.get(row.accountId ?? '')?.get(importedId);
    if (!transactionId) continue;
    matched.set(rowKey(row), transactionId);
  }
  return matched;
}

/**
 * Pure: the key a row's FITID is ambiguous under.
 *
 * The account is part of the key, because a FITID is only unique within
 * one account.
 */
function ambiguityKey(
  accountId: string | undefined,
  importedId: string,
): string {
  return `${accountId ?? ''}\u0000${importedId}`;
}
