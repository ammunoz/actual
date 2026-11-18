/**
 * The editing chain's pure parts.
 *
 * The chain is the review's way through a row: `e` opens the payee, the
 * user commits it, and the editor moves on to the category, then the
 * notes, then — if the row needs it — the amount. One keypress, one row
 * finished.
 *
 * Everything that can be decided without a DOM is decided here, so it can
 * be tested without one:
 *
 *   - which fields the chain visits,
 *   - where it starts,
 *   - which field comes next.
 *
 * The chain SKIPS four kinds of field:
 *
 *   - the category, on a transfer row and on a split row: a transfer has
 *     no category of its own, and a split's legs carry their own;
 *   - the amount, on a split row: the legs have to add up to it, and the
 *     split pane is where it is fixed;
 *   - any field a RULE owns: the editor would refuse the commit, so
 *     offering the field would only produce a refusal;
 *   - the amount, unless the row is FLAGGED about its amount: the amount
 *     is the last field of the chain, and it is only worth a stop when
 *     something is wrong with it.
 */

import {
  effectiveTransferAccountId,
  isSplitRow,
} from '@actual-app/core/server/transactions/import/review/index';
import type { PreviewRow } from '@actual-app/core/server/transactions/import/review/index';

import type { EditorMode } from './editor-mode';
import { RULED_FIELD_FOR_MODE } from './rule-effects';
import type { RuledField } from './rule-effects';

/**
 * The fields the chain walks, in order.
 *
 * The order is the order a person reads a transaction: who it was, what
 * it was for, what it said, and how much.
 */
export const CHAIN_ORDER: readonly EditorMode[] = Object.freeze([
  'payee',
  'category',
  'memo',
  'amount',
]);

/**
 * What the chain knows about the row it is walking.
 */
export type ChainContext = {
  /** The fields remaining in the chain, including the current one. */
  readonly remaining: readonly EditorMode[];
};

/**
 * Pure: whether the row's category is part of the chain.
 *
 * A transfer row has no category of its own — the account it transfers to
 * is the category — and a split's legs carry their own categories, so the
 * parent has none to set.
 */
function hasChainCategory(row: PreviewRow): boolean {
  if (effectiveTransferAccountId(row) !== undefined) return false;
  if (isSplitRow(row.edits)) return false;
  return true;
}

/**
 * Pure: the fields the chain visits on this row.
 *
 * The amount is in the chain only when the row is flagged about its
 * amount: it is the last stop, and there is no reason to stop there when
 * the amount is fine.
 */
function chainFields(
  row: PreviewRow,
  ruledFields: ReadonlySet<RuledField>,
  hasAmountFlag: boolean,
): readonly EditorMode[] {
  return CHAIN_ORDER.filter(mode => {
    if (mode === 'amount' && !hasAmountFlag) return false;
    // A split's amount belongs to the split: the legs have to add up to
    // it, and the editor refuses to change it. The split pane is where
    // a split's amount is fixed, so the chain does not stop there.
    if (mode === 'amount' && isSplitRow(row.edits)) return false;
    // A field a RULE owns is not the user's to change, so the chain does
    // not stop there.
    if (ruledFields.has(RULED_FIELD_FOR_MODE[mode])) return false;
    if (mode === 'category' && !hasChainCategory(row)) return false;
    return true;
  });
}

/**
 * Pure: where the chain starts, and what it plans to visit.
 *
 * **The chain starts past a ruled payee.** The payee is usually the first
 * field, but a rule that owns it means the user cannot change it, so the
 * chain starts at the first field that is neither ruled nor inapplicable.
 *
 * The plan is a SNAPSHOT of the row as it is now. The modal rebuilds it
 * after every commit, because a commit can change the row: giving a
 * transfer row a payee makes it an ordinary transaction, and an ordinary
 * transaction needs a category.
 */
export function initialChainContext(
  row: PreviewRow,
  ruledFields: ReadonlySet<RuledField>,
  hasAmountFlag: boolean,
): ChainContext {
  return { remaining: chainFields(row, ruledFields, hasAmountFlag) };
}

/**
 * Pure: the next field in the chain.
 *
 * `undefined` means the chain is over: the field the user is on is the
 * last one.
 *
 * The CONTEXT is the chain's plan — the fields it visits — and the row
 * is the row AS IT IS NOW. A field that has stopped applying (the row
 * is no longer a transfer) drops out of the chain, and the one after it
 * comes next.
 *
 * The rules' effects are refreshed asynchronously, so the fields a rule
 * owns are the ones known when the chain stepped. A rule that starts
 * owning a field the user has just changed is caught by the editor's
 * own refusal, which says so — and the chain moves on rather than
 * standing on a field the user cannot change.
 *
 * The amount comes AFTER the notes, never before: an amount is the last
 * thing a person checks.
 */
export function nextChainField(
  current: EditorMode,
  context: ChainContext,
  row: PreviewRow,
  ruledFields: ReadonlySet<RuledField>,
): EditorMode | undefined {
  const fields = context.remaining.filter(mode => {
    // A field a RULE owns is not the user's to change, so the chain does
    // not stop there. A rule can start owning a field while the chain
    // is running: the user's own edit can make a rule fire.
    if (ruledFields.has(RULED_FIELD_FOR_MODE[mode])) return false;
    // The category belongs to the row, not to the chain: a row that has
    // become an ordinary transaction needs one.
    if (mode === 'category' && !hasChainCategory(row)) return false;
    return true;
  });
  const index = fields.indexOf(current);
  // The field the user is on is not in the chain — a field a rule owns,
  // or a field the row does not have. The chain is over.
  if (index === -1) return undefined;
  return fields[index + 1];
}
