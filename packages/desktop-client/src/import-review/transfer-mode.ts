/**
 * The transfer editor's pure parts.
 *
 * The transfer pane is deliberately dumb: it holds a draft of one account
 * id and hands it over. Everything that can be decided without a DOM is
 * decided here, so it can be tested without one.
 *
 * The rules that decide what a transfer IS live in the domain
 * (`effectiveTransferAccountId`, `withTransfer`); this module only works
 * out WHICH accounts the user may pick.
 */

import type {
  ReviewAccount,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';

import type { EditorSuggestion } from './editor-mode';

/**
 * Pure: the accounts the user may pick as a transfer target.
 *
 * Three accounts are ruled out, and each one for a reason:
 *
 *   - An account with NO transfer payee. The import needs the account's
 *     hidden transfer payee to send a transfer, and a budget without one
 *     cannot honour the pick: the payload falls back to the ordinary
 *     payee path and the row lands as an ordinary transaction, with
 *     nothing saying so. Actual creates a transfer payee with every
 *     account, so this is rare — but a pick the apply step cannot
 *     honour is not offered at all.
 *
 *   - A CLOSED account. Upstream's own account picker does not offer
 *     closed accounts as transfer targets.
 *
 *   - The account the import is going INTO. A transfer to itself is not
 *     a transfer, and upstream filters it out for the same reason.
 *
 * The order is the accounts' own order, which is the order the budget
 * shows them in.
 */
export function transferTargets(
  accounts: readonly ReviewAccount[],
  payees: readonly ReviewPayee[],
  sourceAccountId: string,
): readonly EditorSuggestion[] {
  const accountsWithPayee = new Set(
    payees.flatMap(payee => (payee.transferAcct ? [payee.transferAcct] : [])),
  );

  return accounts
    .filter(
      account =>
        account.id !== sourceAccountId &&
        !account.closed &&
        accountsWithPayee.has(account.id),
    )
    .map(account => ({ id: account.id, name: account.name }));
}
